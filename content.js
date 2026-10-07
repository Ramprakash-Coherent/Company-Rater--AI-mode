/**
 * content.js - runs on https://www.google.com/search* pages.
 *
 * This extension searches in BATCHES: GET_CURRENT hands this script a
 * list of several companies (up to project.batchSize) claimed together,
 * and background.js's buildSearchUrl turned all of them into ONE Google
 * query asking about each in turn (buildBatchPrompt), demanding a strict
 * numbered reply:
 *   1. WEBSITE: <url or NONE> | RATING: <1-10 or NONE> | REASON: <one sentence>
 *   2. WEBSITE: ... | RATING: ... | REASON: ...
 *   ...
 * A company whose website was already supplied in the input CSV has that
 * website named in the question, so the AI rates the right company - the
 * website it reports back for such a company is ignored by background.js.
 * runBatch() below parses that by finding every numbered line's answer
 * on the page and matching it back to the company at that position
 * in the list, purely by the order they appear in (NOT by the leading
 * number itself - see extractBatchAnswers()'s comment for why) - far more
 * precise than scanning the whole page for "any URL/email/phone it can
 * find". A company whose line doesn't parse is never guessed at: if the whole
 * answer came back empty the search is RELOADED once (Google often answers on
 * a second attempt), and anything still unresolved after that is recorded
 * not_found so the run moves straight on to the next batch.
 *
 * SOLO SEARCHES ARE DISABLED. Pulling stragglers out for one-company-at-a-time
 * searches was correct but ruinously slow - one missing line cost five extra
 * searches - and throughput is the priority. A not_found row is still
 * recoverable later via the popup's "Retry not-found rows".
 *
 * A claim of exactly one company (project.batchSize === 1, or a
 * forceSingle straggler) uses runSingle() instead - the original
 * one-company flow: its own prompt (buildPrompt in background.js), and, if
 * that comes back with literally nothing, one plain-search fallback pass in
 * the same tab (Knowledge Panel + first organic result). sessionStorage
 * (scoped to this tab, cleared when the tab closes) marks that the fallback
 * was already used for a given item, so it can only ever happen once per
 * company.
 *
 * Reading the page: always via deepText()/pageText(), never
 * document.body.innerText - Google composes parts of its answer inside web
 * components, and text inside a shadow root is invisible to innerText. See
 * deepText() below.
 *
 * NOTE ON AI MODE: this deliberately no longer requests &udm=50. Chrome now
 * intercepts that and renders it on an internal chrome:// page that no
 * extension may read - see buildSearchUrl() in background.js.
 *
 * CAPTCHA handling: hitting one doesn't fail the batch. Instead this
 * script tells background.js (which pauses the whole run and brings this
 * tab to the front) and then just waits - however long it takes - for a
 * human to clear it. See waitForCaptchaSolved() and background.js's
 * CAPTCHA_WATCHDOG_MS for the give-up backstop if nobody ever comes back.
 *
 * If this page load isn't part of an active automation run (e.g. you're
 * just browsing Google yourself), GET_CURRENT returns null and this script
 * does nothing.
 */

(function () {
  // background.js re-injects this file after a navigation completes (a
  // declarative content_scripts registration can miss a client-side/soft
  // navigation), so the same page can legitimately get two copies. Only the
  // first one should drive the search.
  if (window.__aiModeScraperBooted) return;
  window.__aiModeScraperBooted = true;

  // Set to false to silence the diagnostic logs below. They print in the
  // worker tab's OWN console (right-click that tab -> Inspect -> Console) -
  // the only practical way to see why a given batch resolved the way it
  // did: how long it waited, how many answer lines were actually on the
  // page when it looked, and what it reported back.
  const DEBUG = true;
  function debug(...args) {
    if (DEBUG) console.log("[CompanyFinder AI]", ...args);
  }

  const BLOCK_CHECK_MS = 500;
  // How long to let AI Mode's answer stream in. These are deliberately
  // generous: AI Mode does real multi-step web research before it writes
  // anything (the page sits on a "Searching..." indicator the whole time),
  // and giving up early is actively harmful, not just slow - a solo
  // company whose answer hadn't rendered yet falls through to the
  // plain-search fallback and gets recorded not_found even though AI Mode
  // was about to answer it, and a batch that times out early sends every
  // company in it back for a slow solo retry. That cascade is exactly what
  // "it searches but never extracts anything" looks like from outside.
  // ANSWER_SETTLE_MS below means a fast answer still doesn't pay the full
  // wait.
  //
  // HARD CONSTRAINT: the longest wait possible here must stay comfortably
  // BELOW background.js's per-batch watchdog (computeWatchdogMs) plus page
  // load time, or the watchdog fires first and marks the whole in-flight
  // batch not_found before this script ever reports a real answer. If you
  // raise these, raise those too.
  const ANSWER_WAIT_MS = 60000;
  const BATCH_ANSWER_BASE_MS = 60000;
  const BATCH_ANSWER_PER_ITEM_MS = 12000;
  const BATCH_ANSWER_MAX_MS = 180000;
  // The wait is driven by whether the PAGE IS STILL PRODUCING OUTPUT, not by
  // elapsed time: as long as the text keeps changing, the answer is still
  // arriving and the wait keeps going (up to the hard cap above). Only after
  // the page has been completely quiet for this long - and isn't showing a
  // "Searching..."-style indicator - is the answer treated as finished.
  //
  // How much silence counts as "finished" depends on whether an answer is
  // already partly on the page, because the two situations mean opposite
  // things:
  //
  //   nothing parseable yet -> most likely this query simply isn't getting an
  //     answer panel at all. Waiting the full cap on every such page would
  //     waste minutes per batch, so give up on silence relatively quickly.
  //
  //   a PARTIAL answer -> Google is mid-answer: it wrote some lines and went
  //     back to researching the rest, and it does go quiet for a long time
  //     while doing so (measured: ~28s of total silence between line 2 and
  //     line 3 of a five-company answer). Treating that pause as "finished"
  //     is the expensive failure - it accepts 2 lines and ships the other 3
  //     companies off to slow solo searches, seconds before their answers
  //     land on screen. So silence has to last much longer before a partial
  //     answer is accepted as complete.
  const ANSWER_QUIET_MS = 12000;
  const PARTIAL_QUIET_MS = 45000;
  // Google's answer streaming fires mutations in bursts; re-reading the page on
  // every single one would mean hundreds of full innerText reads a second.
  // Coalesced on a timestamp rather than a timer, because a timer is the one
  // thing that gets throttled in the hidden tabs this has to work in.
  const OBSERVER_COALESCE_MS = 300;

  // Set while a wait is in progress: calling it ends that wait immediately and
  // reports whatever is on the page. background.js triggers it with REPORT_NOW
  // when a batch nears its watchdog deadline - message delivery still works in
  // a throttled tab even when its timers have effectively stopped, so an
  // answer that did arrive can still be collected rather than written off.
  let nudgeNow = null;
  const PANEL_WAIT_MS = 4000;
  const ORGANIC_WAIT_MS = 1200;
  const POLL_MS = 250;
  // How long this script itself will keep polling a CAPTCHA page waiting
  // for a human to clear it, before giving up and reporting "blocked" on
  // its own. Deliberately much longer than background.js's own
  // CAPTCHA_WATCHDOG_MS (10 min) - that alarm-based watchdog is the real
  // backstop and will normally free the worker first even if you never
  // come back; this is only a last-resort safety net for the rare case
  // that alarm doesn't fire (e.g. the tab was closed and reopened by hand).
  const CAPTCHA_POLL_TIMEOUT_MS = 20 * 60 * 1000;

  const DIRECTORY_OR_SOCIAL_DOMAINS = [
    "google.com", "youtube.com", "facebook.com", "instagram.com",
    "linkedin.com", "twitter.com", "x.com", "tiktok.com",
    "wikipedia.org", "yelp.com", "yellowpages.com", "crunchbase.com",
    "bloomberg.com", "indiamart.com", "justdial.com", "glassdoor.com",
    "indeed.com", "tradeindia.com", "zoominfo.com", "opencorporates.com",
    "dnb.com", "amazon.com", "tripadvisor.com", "maps.google.com",
    "goo.gl", "bing.com", "apple.com", "play.google.com",
  ];

  function isUsableUrl(url) {
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./, "").toLowerCase();
      if (!host.includes(".")) return false;
      return !DIRECTORY_OR_SOCIAL_DOMAINS.some((d) => host === d || host.endsWith("." + d));
    } catch {
      return false;
    }
  }

  function isBlockedPage() {
    if (location.pathname.startsWith("/sorry/")) return true;
    const bodyText = pageText().toLowerCase();
    return (
      bodyText.includes("unusual traffic") ||
      bodyText.includes("detected unusual traffic") ||
      !!document.querySelector("iframe[src*='recaptcha']") ||
      !!document.querySelector("#captcha-form")
    );
  }

  // --- Passive Knowledge-Panel-style read (used by runSingle - a batched
  // multi-company query has no single recognized business for Google to
  // render a card for, so this is skipped in runBatch). ---

  function getKnowledgePanelWebsite() {
    const links = Array.from(document.querySelectorAll("a[href^='http']"));
    let match = links.find((a) => {
      const label = (a.getAttribute("aria-label") || a.textContent || "").trim().toLowerCase();
      return (label === "website" || label.startsWith("website")) && isUsableUrl(a.href);
    });
    if (match) return match.href;
    match = links.find((a) => {
      const label = (a.getAttribute("aria-label") || a.textContent || "").trim().toLowerCase();
      return /\bofficial (website|site)\b/.test(label) && isUsableUrl(a.href);
    });
    return match ? match.href : null;
  }

  function extractOrganicResultUrl() {
    const container = document.querySelector("#search") || document.body;
    const links = Array.from(container.querySelectorAll("a[href^='http']"));
    for (const a of links) {
      if (isUsableUrl(a.href)) return a.href;
    }
    return null;
  }

  // --- Reading the answer text off the page ---

  // Google renders parts of its answer inside web components, and text inside
  // a shadow root is NOT returned by document.body.innerText - so reading
  // innerText alone can come back empty (or missing whole lines) while the
  // answer is plainly visible on screen. This walks the real composed tree,
  // stepping into every open shadowRoot it meets, which is how the answer
  // gets read reliably regardless of how Google chooses to compose the page.
  //
  // (Text in a CLOSED shadow root is unreachable from any page script. If
  // Google ever moves the answer there, the remaining option is reading the
  // accessibility tree via the chrome.debugger API from background.js, which
  // needs the "debugger" permission and attaches a visible "being debugged"
  // banner to the tab - deliberately not done here unless it becomes
  // necessary.)
  // Only these force a line break. Everything else (notably <a> and <span>)
  // is treated as inline and kept on the SAME line, which matters more than
  // it looks: Google renders some answer values as links and wraps others in
  // spans, so a walker that emitted one line per text node would split a
  // single "WEBSITE: x | RATING: y | REASON: z" answer across three lines - and
  // extractBatchAnswers() requires those fields on one line (its capture
  // groups deliberately stop at a newline). Breaking only at real block
  // boundaries keeps each answer line intact however Google marks it up.
  const BLOCK_TAGS = new Set([
    "address", "article", "aside", "blockquote", "br", "dd", "details", "div", "dl", "dt",
    "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
    "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "summary", "table",
    "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
  ]);

  function deepText(root) {
    let out = "";
    const breakLine = () => {
      if (out && !out.endsWith("\n")) out += "\n";
    };
    const walk = (node) => {
      if (!node) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const t = (node.textContent || "").replace(/\s+/g, " ");
        if (t.trim()) out += t;
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
      const tag = (node.tagName || "").toLowerCase();
      if (tag === "script" || tag === "style" || tag === "noscript" || tag === "template") return;
      const isBlock = BLOCK_TAGS.has(tag);
      if (isBlock) breakLine();
      if (node.shadowRoot) walk(node.shadowRoot);
      for (const child of node.childNodes) walk(child);
      if (isBlock) breakLine();
    };
    walk(root);
    return out
      .replace(/[ \t]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // The primary read is innerText, NOT the tree-walker below, and that choice
  // is load-bearing: innerText is CSS-aware - it breaks lines the way the page
  // actually renders - whereas any hand-rolled walker has to guess from tag
  // names. Google composes one rendered answer line out of several nested
  // <div>s styled inline, so a tag-list walker inserts newlines *inside* an
  // answer line, splitting "WEBSITE: x | RATING: y | REASON: z" across three
  // lines. extractBatchAnswers() requires those fields on ONE line, so that
  // yields zero matches on a page whose answer is perfectly fine - every
  // company then gets bounced to a solo search. Measured on the real page:
  // innerText finds all 5 answer lines; the walker found none.
  //
  // deepText() is kept strictly as a fallback for the case innerText cannot
  // cover (text composed inside a shadow root, which innerText omits) - see
  // deepenIfEmpty() and its use in runBatch/runSingle.
  function pageText() {
    if (!document.body) return "";
    const light = document.body.innerText || "";
    return light.trim() ? light : deepText(document.body);
  }

  // Second opinion for when the normal read produced nothing parseable: an
  // answer composed inside a web component's shadow root is invisible to
  // innerText, and only then is the tag-based walker worth its inaccuracy.
  // `count` says how many parseable items each candidate text yields, so the
  // deeper read is only adopted if it genuinely finds more.
  function deepenIfEmpty(text, count) {
    if (count(text) > 0 || !document.body) return text;
    const deep = deepText(document.body);
    return count(deep) > count(text) ? deep : text;
  }

  // Google shows these while it is still researching/generating - they are a
  // "not finished yet" signal, never an answer. Accepting a page in this
  // state is what makes a search look like it "found nothing" when the real
  // answer was seconds away.
  function isStillGenerating(text) {
    return /\b(thinking(?:\s+a\s+little\s+longer)?|searching|generating|loading)\b/i.test(text || "");
  }

  // --- Answer parsing helpers shared by both flows ---

  function cleanValue(raw) {
    return raw.replace(/\*/g, "").trim().replace(/[.,;]+$/, "");
  }

  // Google's rendering can leave small artifacts attached to a value it's
  // citing - a footnote/citation marker glued on with no separating
  // space, a zero-width/invisible formatting character, a trailing
  // parenthetical - none of which are part of the actual website or
  // rating themselves. Requiring the ENTIRE captured segment to parse as a
  // clean URL used to reject real, correctly-formatted answers over one such
  // artifact (see CHANGELOG.md), so toWebsite()/toRating() extract the
  // target pattern as a substring out of the (possibly noisy) captured
  // text, rather than requiring the whole segment to already be exactly that.
  // Built via RegExp(string) rather than a /regex literal/ so the
  // characters being matched are spelled out as explicit \u escapes in
  // the source - not typed as literal invisible characters that would be
  // impossible to review or tell apart from an accidental blank edit.
  const INVISIBLE_CHARS_RE = new RegExp("[\\u200B\\u200C\\u200D\\uFEFF]", "g");
  const URL_TOKEN_RE = /https?:\/\/[^\s|]+|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s|]*)?/i;

  function isNoneValue(raw) {
    return !raw || /^\s*none\s*$/i.test(raw);
  }

  // Google's AI Mode echoes the query itself back as a "chat bubble" ABOVE
  // its answer - sometimes in full, but a long query (any batch prompt,
  // and even a solo one) is often shown collapsed/truncated behind a
  // "show more" toggle instead, so how much of it (if any) actually makes
  // it into document.body.innerText is NOT something this code can rely
  // on (see CHANGELOG.md - this used to assume the echo always contributes
  // exactly one extra match, which broke extraction completely once that
  // assumption stopped holding). Rather than count matches and guess which
  // one is the echo, any match is recognized directly as the prompt's own
  // instructional template - not a real answer - if its captured value
  // still contains the literal "<" / ">" placeholder brackets from
  // buildPrompt/buildBatchPrompt, e.g. "<official website URL, or NONE if
  // you can't find one>". A real website/email/phone value can never
  // legitimately contain either character, so this has no false-positive
  // risk, and it works whether the echo renders in full, partially (it
  // then usually fails to match at all, well before reaching this point in
  // the prompt), or not at all.
  function isPlaceholderTemplateValue(raw) {
    return /[<>]/.test(raw);
  }

  function toWebsite(raw) {
    if (isNoneValue(raw)) return null;
    const match = raw.replace(INVISIBLE_CHARS_RE, "").match(URL_TOKEN_RE);
    if (!match) return null;
    const candidate = match[0].replace(/[),.;:'"<>]+$/, ""); // trailing punctuation the surrounding sentence/markup left attached
    const url = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate.replace(/^\/+/, "")}`;
    return isUsableUrl(url) ? url : null;
  }

  // REASON is free text, so unlike WEBSITE there is no token pattern to
  // extract - whatever the model wrote IS the value. A website field answered
  // "Not publicly available" fails its URL match and comes out null on its
  // own, but the same words would sail straight into the reason column. The
  // prompt asks for NONE, and mostly gets it, but a generative answer phrases
  // "I don't know" a dozen ways, so the common ones are recognised here too.
  // RATING goes through this as well, so "Not enough information" is never
  // mistaken for a number that happens to appear later in the text.
  const NO_VALUE_RE =
    /^(none|n\/?a|null|unknown|not\s+(found|known|available|listed|specified|rated|public|publicly\s+(available|listed|known))|(no|not\s+enough|insufficient)\s+(public\s+)?(information|data|evidence)(\s+\w+)*)$/i;

  function isMissingText(raw) {
    if (!raw) return true;
    const cleaned = raw.replace(INVISIBLE_CHARS_RE, "").replace(/\s+/g, " ").trim().replace(/[.!]+$/, "");
    return !cleaned || NO_VALUE_RE.test(cleaned);
  }

  function tidyText(raw) {
    return raw.replace(INVISIBLE_CHARS_RE, "").replace(/\s+/g, " ").trim().replace(/[,;.]+$/, "");
  }

  // The prompt asks for a whole number from 1 to 10, but "7/10", "8 out of
  // 10" and "7.5" all turn up anyway - the first number in the value is
  // taken and rounded. Anything outside 1-10 is treated as no rating rather
  // than clamped, since it means the model answered something other than
  // the question.
  function toRating(raw) {
    if (isMissingText(raw)) return null;
    const match = raw.replace(INVISIBLE_CHARS_RE, "").match(/\d+(?:[.,]\d+)?/);
    if (!match) return null;
    const n = Math.round(parseFloat(match[0].replace(",", ".")));
    return n >= 1 && n <= 10 ? n : null;
  }

  function toReason(raw) {
    if (isMissingText(raw)) return null;
    return tidyText(raw) || null;
  }

  // How Google actually lays the answer out (measured on a live AI Overview,
  // Oct 2026) is NOT the tidy one-line format the prompt asks for:
  //
  //   WEBSITE: Solina Denmark (Group site) / Solina Retail DK (Danish retail site)
  //   Solina Denmark
  //    +1
  //   RATING: 8.5 / 10
  //   REASON: Solina Denmark A/S enjoys a highly robust reputation ...
  //
  // Each field on its own line, citation chips ("Solina Denmark +1") wedged
  // in between, and the website written as a NAME with the real address only
  // in the link behind it (see websiteLinksByLabel). So instead of one rigid
  // regex, each label is found on its own and its value read to the end of
  // its line (or the next "|"), and a WEBSITE is paired with the RATING and
  // REASON that follow it before the next WEBSITE.
  //
  // Labels are matched UPPERCASE ONLY (no "i" flag) - the answer uses the
  // exact labels the prompt asked for, while review snippets elsewhere on a
  // results page say "Rating: 4.6", which must never be read as a rating.
  // Markdown emphasis ("**RATING:** 7") is tolerated.
  const LABEL_RE = /\*{0,2}\b(WEBSITE|RATING|REASON)\s*\*{0,2}\s*:\s*\*{0,2}/g;
  // A RATING/REASON further than this from its WEBSITE belongs to something
  // else on the page, not to this answer.
  const MAX_FIELD_GAP = 800;

  function isPlaceholderOrEcho(raw) {
    return isPlaceholderTemplateValue(raw) || /^\s*(\.\.\.|…)/.test(raw);
  }

  // Finds every WEBSITE -> RATING -> REASON answer in the page text, in
  // reading order. The prompt's own echo ("WEBSITE: ... | RATING: ...", or
  // the "<...>" placeholders) is skipped - see isPlaceholderOrEcho.
  //
  // `rawWebsite` is kept so a website written as a name can be resolved to
  // its real address from the page's links afterwards (resolveWebsites).
  // `complete` says a REASON came with it. `pending` marks an answer whose
  // RATING is followed by a "|" with no REASON yet: the reason is still
  // streaming in, so the wait shouldn't end one instant early.
  function extractAnswers(text) {
    const labels = [...text.matchAll(LABEL_RE)].map((m) => ({
      name: m[1],
      start: m.index,
      valueStart: m.index + m[0].length,
    }));
    const valueOf = (i) => {
      const end = i + 1 < labels.length ? labels[i + 1].start : text.length;
      // A label sitting alone at the end of its line takes the next line.
      const raw = text.slice(labels[i].valueStart, end).replace(/^[ \t]*\n?[ \t]*/, "");
      const cut = raw.search(/[|\n]/);
      return {
        raw: (cut === -1 ? raw : raw.slice(0, cut)).trim(),
        endsInPipe: cut !== -1 && raw[cut] === "|",
      };
    };

    const answers = [];
    for (let i = 0; i < labels.length; i++) {
      if (labels[i].name !== "WEBSITE") continue;
      const site = valueOf(i);
      if (isPlaceholderOrEcho(site.raw)) continue;
      let rating = null;
      let reason = null;
      for (let j = i + 1; j < labels.length && labels[j].name !== "WEBSITE"; j++) {
        if (labels[j].start - labels[i].start > MAX_FIELD_GAP) break;
        if (labels[j].name === "RATING" && !rating) rating = valueOf(j);
        else if (labels[j].name === "REASON" && rating && !reason) reason = valueOf(j);
      }
      if (!rating || isPlaceholderOrEcho(rating.raw)) continue;
      const reasonRaw = reason && !isPlaceholderOrEcho(reason.raw) ? reason.raw : null;
      answers.push({
        rawWebsite: cleanValue(site.raw),
        website: toWebsite(cleanValue(site.raw)),
        rating: toRating(cleanValue(rating.raw)),
        reason: reasonRaw ? toReason(cleanValue(reasonRaw)) : null,
        complete: !!(reason && reason.raw),
        pending: !reason && rating.endsInPipe,
      });
    }
    return answers;
  }

  // Google renders the website in an answer as a LINK, usually showing the
  // company's name rather than its address ("WEBSITE: Solina Denmark"), and
  // the link itself points at a google.com/goto redirect. The real address
  // is still in the page: Google keeps it in an HTML comment right next to
  // the link (<!--...[["https://www.solina.com/",...]]-->). This walks the
  // DOM from each "WEBSITE:" label to the next "RATING:"/"REASON:" label and
  // collects the first usable address it finds there - from such a comment,
  // or from an ordinary link that isn't a Google redirect.
  //
  // This leans on undocumented markup; if Google changes it, the website
  // simply comes back empty and the rating is unaffected.
  function websiteLinksByLabel() {
    const out = [];
    if (!document.body) return out;
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT
    );
    let cur = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === Node.TEXT_NODE) {
        const t = n.textContent || "";
        if (/\bWEBSITE\s*:/.test(t)) {
          cur = { text: t.split(/WEBSITE\s*:/).pop(), urls: [] };
          out.push(cur);
        } else if (/\b(RATING|REASON)\s*:/.test(t)) {
          cur = null;
        } else if (cur && cur.text.length < 300) {
          cur.text += t;
        }
      } else if (cur && n.nodeType === Node.COMMENT_NODE) {
        for (const m of (n.textContent || "").matchAll(/https?:\/\/[^\s"'\\\]]+/g)) cur.urls.push(m[0]);
      } else if (cur && n.tagName === "A" && n.href) {
        cur.urls.push(n.href);
      }
    }
    return out.map((e) => ({
      text: e.text.replace(/\*/g, "").replace(/\s+/g, " ").trim(),
      url: e.urls.find((u) => isUsableUrl(u)) || null,
    }));
  }

  // Fills in `website` for answers whose WEBSITE was written as a name, by
  // finding that same label in the DOM (matched on the start of its text)
  // and taking the address behind it. Answers that already have a website,
  // or that said NONE, are left alone.
  function resolveWebsites(answers) {
    if (!answers.some((a) => !a.website && !isMissingText(a.rawWebsite))) return answers;
    const dom = websiteLinksByLabel().filter((d) => d.url);
    const used = new Set();
    return answers.map((a) => {
      if (a.website || isMissingText(a.rawWebsite)) return a;
      const key = a.rawWebsite.replace(/\s+/g, " ").trim().slice(0, 20).toLowerCase();
      const idx = dom.findIndex((d, k) => !used.has(k) && key && d.text.toLowerCase().startsWith(key));
      if (idx === -1) return a;
      used.add(idx);
      return { ...a, website: dom[idx].url };
    });
  }

  // The real answer is always the LAST one in reading order - anything
  // earlier is an echo of the question.
  function extractSoloAnswer(text) {
    const all = extractAnswers(text);
    return all.length ? all[all.length - 1] : null;
  }

  // Batch answer: one WEBSITE/RATING/REASON group per company - see
  // buildBatchPrompt in background.js. Deliberately NOT anchored on a
  // leading company number, even though the prompt asks for one: Google
  // very often renders a numbered reply as a real HTML ordered list, and a
  // list's auto-generated item numbers ("1.", "2.", ...) are rendering-only
  // - they are NOT part of document.body.innerText at all (see
  // CHANGELOG.md). Answers are assigned to companies by the ORDER they
  // appear in instead (or by name when the count is off - see
  // pairTriplesByName).
  function extractBatchAnswers(text) {
    return extractAnswers(text);
  }

  // --- Pairing answer lines to companies by name, not just by position ---

  // Legal-form and generic industry words match almost every German B2B name
  // ("GmbH", "Technik", "Vertrieb"...), so using them as evidence would pair
  // companies to whichever line happened to be nearby. Only distinctive words
  // count.
  const NAME_STOPWORDS = new Set([
    "gmbh", "mbh", "kgaa", "ohg", "gbr", "co", "kg", "ug", "eg", "inh", "und", "the", "and", "der",
    "company", "gesellschaft", "holding", "group", "gruppe", "international", "deutschland",
    "germany", "niederlassung", "werk", "werke", "industrie", "industries", "technologie",
    "technologies", "technik", "systems", "system", "solutions", "service", "services", "vertrieb",
    "handel", "betriebsgesellschaft", "verpackungstechnik", "maschinenfabrik", "privat",
  ]);

  function foldUmlauts(s) {
    return s
      .replace(/ä/g, "a").replace(/ö/g, "o").replace(/ü/g, "u")
      .replace(/ß/g, "ss").replace(/é|è|ê/g, "e");
  }

  function nameTokens(companyName) {
    return foldUmlauts((companyName || "").toLowerCase())
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 4 && !NAME_STOPWORDS.has(t));
  }

  // The website of an answer line, reduced to bare letters and digits so
  // "kkt-kall.de" and "KKT Kall" can be compared directly.
  function tripleIdentityText(triple) {
    return triple.website ? foldUmlauts(String(triple.website).toLowerCase()).replace(/[^a-z0-9]+/g, "") : "";
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      return "";
    }
  }

  // How strongly one answer line looks like it belongs to one company. The
  // answer repeating the website supplied in the input is the strongest
  // evidence there is. Failing that, a distinctive chunk of the company's own
  // name showing up inside its domain is real, order-independent evidence
  // (igema.com for "IGEMA GmbH", kkt-kall.de for "KKT Kall"). Longer matched
  // token = stronger.
  function matchScore(item, triple) {
    if (item.website && triple.website && hostOf(item.website) === hostOf(triple.website)) return 100;
    const hay = tripleIdentityText(triple);
    if (!hay) return 0;
    let best = 0;
    for (const token of nameTokens(item.company_name)) {
      if (hay.includes(token)) best = Math.max(best, token.length);
    }
    return best;
  }

  // Salvages a batch answer that isn't exactly one line per company.
  //
  // Such an answer used to be discarded wholesale - every company in it went
  // back for its own solo search, the slowest path there is, and the main
  // reason a big run crawls along at a fraction of its nominal rate. Position
  // genuinely can't be trusted once a line is missing or merged (one skip
  // shifts every company after it), but name-to-domain evidence doesn't depend
  // on position at all. So each company is paired with the line that most
  // strongly carries its name, strongest matches claimed first, one line per
  // company; whoever is left with no such evidence still falls back to a solo
  // retry rather than being guessed at.
  function pairTriplesByName(items, triples) {
    const candidates = [];
    items.forEach((item, i) => {
      triples.forEach((triple, j) => {
        const score = matchScore(item, triple);
        if (score > 0) candidates.push({ i, j, score });
      });
    });
    candidates.sort((a, b) => b.score - a.score);
    const paired = new Array(items.length).fill(null);
    const claimed = new Set();
    for (const { i, j } of candidates) {
      if (paired[i] || claimed.has(j)) continue;
      paired[i] = triples[j];
      claimed.add(j);
    }
    return paired;
  }

  async function waitFor(conditionFn, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = conditionFn();
      if (result) return result;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    return null;
  }

  // Waits for Google to finish answering. The rule is "keep waiting while the
  // page is still producing output", NOT "wait N seconds and hope" - a fixed
  // window is a guess about Google's latency, and guessing short is expensive:
  // every answer line missed sends another company off for its own slow solo
  // search, even though the line showed up on screen moments later.
  //
  // Returns:
  //   "ready"   - readyFn(text) is satisfied: everything expected is present.
  //               The normal happy path, and it returns the instant that's
  //               true, so a fast answer is never made to wait.
  //   "settled" - the page went completely quiet for ANSWER_QUIET_MS and
  //               isn't showing a "Searching..." indicator: this is as
  //               complete as the answer is going to get, however many lines
  //               that turned out to be.
  //   "error"   - Google itself reported a failure.
  //   "timeout" - hit the hard cap while still changing. Rare by design.
  // Callers re-read the page and decide what to record either way; this only
  // governs how long to keep looking.
  // DRIVEN BY MUTATIONOBSERVER, NOT BY A TIMER LOOP - and that is the whole
  // point of this function's shape.
  //
  // Worker tabs run hidden (and the window may be minimised), and Chrome
  // throttles TIMERS in hidden tabs: setTimeout/setInterval drop to about once
  // a second, then once a MINUTE once a tab has been hidden a few minutes,
  // which any real run passes almost immediately. A 250ms polling loop
  // therefore becomes a 60s polling loop exactly when the run is left alone,
  // and the answer sits on the page unread until the watchdog writes the whole
  // batch off.
  //
  // A MutationObserver is not throttled that way: it fires when the DOM
  // changes, hidden or not, minimised or not. So the observer is what actually
  // notices Google's answer arriving; the interval below is only a coarse
  // backstop for the give-up paths, where being late costs nothing. Message
  // delivery isn't throttled either - see REPORT_NOW/nudgeNow.
  function waitForAnswer(readyFn, hasAnyFn, maxMs) {
    return new Promise((resolve) => {
      let settled = false;
      let lastLength = -1;
      let lastChangeAt = Date.now();
      let lastCheckAt = 0;

      const finish = (outcome) => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearInterval(backstop);
        clearTimeout(cap);
        nudgeNow = null;
        resolve(outcome);
      };

      const check = () => {
        if (settled) return;
        // Catching a CAPTCHA here (not just once before the wait) is what
        // makes one appearing mid-answer get noticed promptly: this runs off
        // DOM mutations, which a hidden tab still receives normally.
        if (isBlockedPage()) return finish("blocked");
        const text = pageText();
        if (/something went wrong/i.test(text)) return finish("error");
        if (readyFn(text)) return finish("ready");
        if (text.length !== lastLength) {
          // Still streaming - reset the quiet clock, so a slow answer gets as
          // long as it genuinely needs (within the hard cap).
          lastLength = text.length;
          lastChangeAt = Date.now();
        } else if (!isStillGenerating(text)) {
          const quietNeeded = hasAnyFn(text) ? PARTIAL_QUIET_MS : ANSWER_QUIET_MS;
          if (Date.now() - lastChangeAt >= quietNeeded) return finish("settled");
        }
      };

      const observer = new MutationObserver(() => {
        const now = Date.now();
        if (now - lastCheckAt < OBSERVER_COALESCE_MS) return;
        lastCheckAt = now;
        check();
      });
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
      });

      const backstop = setInterval(check, POLL_MS);
      const cap = setTimeout(() => finish("timeout"), maxMs);
      nudgeNow = () => finish("nudged");
      check();
    });
  }


  // Tells background.js a CAPTCHA showed up (it pauses the run and brings
  // this tab to the front for you), then just waits for it to clear.
  // Returns true once isBlockedPage() goes false, or false if
  // CAPTCHA_POLL_TIMEOUT_MS is exceeded with nobody solving it.
  //
  // Note this only returns at all if the CAPTCHA clears *without* the page
  // navigating away (e.g. an inline challenge). The far more common case -
  // Google's separate /sorry/ page redirecting back to the real results
  // once solved - is a real navigation, which tears down this whole script
  // instance before this ever resolves; a fresh content script instance
  // then runs on the reloaded results page and picks the search back up
  // from scratch (GET_CURRENT still hands it the same in-progress batch).
  // Either path ends the same way: the search continues normally.
  async function waitForCaptchaSolved(batchToken) {
    chrome.runtime.sendMessage({ type: "CAPTCHA_DETECTED", batchToken });
    return waitFor(() => !isBlockedPage(), CAPTCHA_POLL_TIMEOUT_MS);
  }

  function fallbackKey(itemId) {
    return `aimFallbackUsed_${itemId}`;
  }

  function buildPlainSearchUrl(item) {
    const q = [item.company_name, item.city, item.country].filter(Boolean).join(" ");
    return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
  }

  // The background engine waits for exactly one RESULT message per claimed
  // batch; if this script throws before sending one (e.g. an assumption
  // about the page's structure doesn't hold), that worker would be stuck
  // waiting forever with nothing to time it out. run() is the outer guard:
  // whatever runInner() does, something always gets reported back.
  // GET_CURRENT is fetched out here (not inside runInner) so the catch-all
  // below still knows which batch/items to tag its fallback report with,
  // even if runInner blows up early.
  // MV3 service workers are stopped when idle and restarted on demand, and a
  // message that lands while one is stopping can fail with "message channel
  // closed" or "Receiving end does not exist" even though the next attempt
  // would wake it fine. A couple of retries keeps one such hiccup from writing
  // a whole batch off.
  async function getCurrentWithRetry() {
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await chrome.runtime.sendMessage({ type: "GET_CURRENT" });
      } catch (err) {
        lastErr = err;
        // Reloaded/removed extension: this copy of the script is orphaned and
        // can never reach it again - retrying is pointless.
        if (!chrome.runtime || !chrome.runtime.id) break;
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    throw lastErr;
  }

  async function run() {
    let current = null;
    try {
      current = await getCurrentWithRetry();
      if (!current || !Array.isArray(current.items) || !current.items.length) return; // not part of an active run - don't touch the page
      await runInner(current);
    } catch (err) {
      console.error("Company Finder (AI Mode): content script error, reporting not_found instead of hanging", err);
      try {
        if (current && current.batchToken && Array.isArray(current.items)) {
          chrome.runtime.sendMessage({
            type: "RESULT",
            batchToken: current.batchToken,
            results: current.items.map((it) => ({ itemId: it.itemId, status: "not_found" })),
          });
        }
      } catch {
        // Extension context itself is gone (e.g. reloaded mid-run) -
        // nothing more we can do from here.
      }
    }
  }

  // Reports every company in the batch as "blocked" - used when a CAPTCHA was
  // never cleared, so they land in needs_review.csv for a manual look instead
  // of being mislabelled not_found.
  function reportAllBlocked(items, batchToken) {
    chrome.runtime.sendMessage({
      type: "RESULT",
      batchToken,
      results: items.map((it) => ({ itemId: it.itemId, status: "blocked" })),
    });
  }

  async function runInner(current) {
    const { batchToken, items } = current;

    // 1. Blocked? Wait (however long it takes) for a human to solve it
    // rather than failing the whole batch outright - see waitForCaptchaSolved.
    //
    // Checked synchronously rather than by polling for BLOCK_CHECK_MS: this
    // runs in a hidden background tab whose timers Chrome throttles to roughly
    // once a minute, so "poll for 500ms" here would really cost up to a minute
    // of EVERY search. A CAPTCHA appearing later is caught by the
    // mutation-driven check inside waitForAnswer instead.
    if (isBlockedPage()) {
      const solved = await waitForCaptchaSolved(batchToken);
      if (!solved) {
        reportAllBlocked(items, batchToken);
        return;
      }
      // Cleared without a navigation (e.g. an inline challenge) - fall
      // through and keep going as if it was never there.
    }

    if (items.length === 1) {
      await runSingle(items[0], batchToken);
    } else {
      await runBatch(items, batchToken);
    }
  }

  // One company, claimed alone - either project.batchSize is 1, or this
  // item was flagged forceSingle after a batch answer didn't clearly cover
  // it. Gets the full treatment: its own AI Mode prompt, and, if that
  // comes back completely empty, one plain-search fallback pass.
  async function runSingle(item, batchToken) {
    const itemId = item.itemId;
    const usedFallback = sessionStorage.getItem(fallbackKey(itemId)) === "1";
    const sendResult = (result) => {
      chrome.runtime.sendMessage({ type: "RESULT", batchToken, results: [{ itemId, ...result }] });
    };

    if (!usedFallback) {
      // Wait for the REAL answer, not just the echoed query rendering - the
      // echoed query contains its own WEBSITE/RATING/REASON lines (it's
      // literally quoting our prompt's instructions). extractSoloAnswer
      // already filters that echoed placeholder line out (see
      // isPlaceholderTemplateValue), so a non-null result means a REAL answer
      // has rendered.
      const started = Date.now();
      // Ready only once REASON has rendered too: on this path the answer is
      // three SEPARATE lines, so stopping as soon as RATING appeared would
      // cut the reason off before it streamed in. When the model leaves the
      // reason out, the "page went quiet" path in waitForAnswer ends the wait
      // instead, which is exactly what it is there for.
      const readyForSingle = (text) => {
        const answer = extractSoloAnswer(text);
        return !!(answer && answer.complete);
      };
      const anyForSingle = (text) => !!extractSoloAnswer(text);
      let outcome = await waitForAnswer(readyForSingle, anyForSingle, ANSWER_WAIT_MS);

      // A CAPTCHA that appeared mid-wait goes to a human exactly like one
      // present on arrival; if it clears without the page navigating away, the
      // answer earns a fresh full wait rather than the company being lost to
      // an interruption that has since been resolved.
      if (outcome === "blocked") {
        const solved = await waitForCaptchaSolved(batchToken);
        if (!solved) {
          sendResult({ status: "blocked" });
          return;
        }
        outcome = await waitForAnswer(readyForSingle, anyForSingle, ANSWER_WAIT_MS);
      }

      const aiRaw = extractSoloAnswer(deepenIfEmpty(pageText(), (t) => extractAnswers(t).length));
      const ai = (aiRaw && resolveWebsites([aiRaw])[0]) || {};
      // A website supplied in the input always wins - background.js never
      // overwrites it - so only look for one when there wasn't one.
      const panelWebsite = item.website ? null : getKnowledgePanelWebsite();
      const website = panelWebsite || ai.website || null;
      const source = panelWebsite ? "knowledge_panel" : ai.website ? "ai_mode" : null;
      const rating = ai.rating ?? null;
      debug("runSingle", item.company_name, {
        outcome,
        waitedMs: Date.now() - started,
        ai,
        panelWebsite,
      });

      if (rating === null && !website && !item.website) {
        // AI Mode came up completely empty - either it errored ("something
        // went wrong") or it genuinely didn't know. A plain search can't
        // produce a rating, but its Knowledge Panel or first organic result
        // can at least find the website, so the row isn't left with nothing
        // and a later "Retry not-rated rows" has a website to work with.
        debug("runSingle -> plain-search fallback for the website (AI Mode gave nothing)", item.company_name);
        chrome.runtime.sendMessage({ type: "RETRY_PLAIN_SEARCH", batchToken });
        sessionStorage.setItem(fallbackKey(itemId), "1");
        location.href = buildPlainSearchUrl(item);
        return; // this script instance is about to be torn down by the navigation
      }

      sendResult({
        status: rating !== null ? "found" : "not_found",
        website, source, rating, ratingReason: ai.reason || null,
      });
      return;
    }

    // Fallback pass: a plain search (no AI Mode), used exactly once, after
    // AI Mode came up completely empty above. Website only - Knowledge Panel
    // + first usable organic result, same as a normal Google search. There
    // is no rating to be had here, so the row stays not_found (not rated).
    sessionStorage.removeItem(fallbackKey(itemId));
    let website = await waitFor(getKnowledgePanelWebsite, PANEL_WAIT_MS);
    let source = website ? "knowledge_panel" : null;
    if (!website) {
      website = await waitFor(extractOrganicResultUrl, ORGANIC_WAIT_MS);
      if (website) source = "organic";
    }
    sendResult({ status: "not_found", website, source });
  }

  // Several companies, asked about in one AI Mode query (buildBatchPrompt
  // in background.js). Waits for every numbered line to become parseable
  // (or the batch-scaled timeout, whichever comes first), then resolves
  // what it can and flags the rest forceSingle rather than guessing.
  async function runBatch(items, batchToken) {
    const waitMs = Math.min(BATCH_ANSWER_BASE_MS + BATCH_ANSWER_PER_ITEM_MS * items.length, BATCH_ANSWER_MAX_MS);
    const started = Date.now();
    // A line still trailing an unanswered "|" does not count as ready yet -
    // see `pending` in extractAnswers. This keeps the pace unchanged for a
    // model that omits the reason entirely, while not cutting off a model
    // that is part-way through writing it.
    const readyForBatch = (text) => extractBatchAnswers(text).filter((t) => !t.pending).length >= items.length;
    const anyForBatch = (text) => extractBatchAnswers(text).length > 0;
    let outcome = await waitForAnswer(readyForBatch, anyForBatch, waitMs);

    // A CAPTCHA that appeared mid-wait: hand it to a human, then give the
    // answer another full wait if it clears, rather than throwing the batch
    // away over an interruption that has since been resolved.
    if (outcome === "blocked") {
      const solved = await waitForCaptchaSolved(batchToken);
      if (!solved) {
        reportAllBlocked(items, batchToken);
        return;
      }
      outcome = await waitForAnswer(readyForBatch, anyForBatch, waitMs);
    }

    const answerText = deepenIfEmpty(pageText(), (t) => extractBatchAnswers(t).length);
    // extractBatchAnswers() already excludes the prompt's own echoed example
    // (see isPlaceholderTemplateValue) - what's left should be exactly one
    // real answer per company. If it isn't (the model skipped one, merged
    // two, or added an extra), positional matching can no longer be
    // trusted, since a single skip/merge would silently shift every
    // company after it out of alignment - see the pairing below.
    const allTriples = resolveWebsites(extractBatchAnswers(answerText));

    // Nothing at all came back for this search. Rather than accept that (and
    // rather than dripping every company through a slow solo search, which
    // is no longer used at all), reload the exact same query ONCE - Google
    // frequently answers on a second attempt when the first produced no
    // answer panel. If the retry is also empty, the whole batch is recorded
    // not_found below and the run moves straight on to the next batch, which
    // is what keeps throughput up.
    //
    // Only a completely empty answer triggers this. If even one company
    // parsed, that data is reported immediately instead - a reload would
    // re-ask the whole batch and its answer could come back worse, and the
    // engine only accepts one RESULT per batch, so there would be no way to
    // keep the better of the two.
    if (allTriples.length === 0) {
      const retryKey = `aimBatchRetried_${batchToken}`;
      if (sessionStorage.getItem(retryKey) !== "1") {
        sessionStorage.setItem(retryKey, "1");
        debug(
          `runBatch: no answer at all (outcome ${outcome}) for ${items.length} companies - ` +
            `reloading this search once before giving up`
        );
        // Re-arm the watchdog first: a second full wait would otherwise run
        // past the deadline armed for the first one, and the watchdog marks
        // the whole batch not_found when it fires.
        chrome.runtime.sendMessage({ type: "RETRY_SEARCH", batchToken });
        location.reload();
        return; // this script instance is about to be torn down by the reload
      }
      debug(`runBatch: retry also came back empty - recording ${items.length} not_found and moving on`);
    }
    // Exactly one line per company is the clean case: order is trustworthy,
    // so pair by position. Anything else falls back to name-based pairing
    // rather than discarding the whole batch - see pairTriplesByName().
    const positional = allTriples.length === items.length ? allTriples : null;
    const paired = positional || pairTriplesByName(items, allTriples);
    debug("runBatch", {
      companies: items.length,
      outcome,
      waitedMs: Date.now() - started,
      triplesFound: allTriples.length,
      pairing: positional ? "positional (exact count)" : "by-name (count mismatch)",
      resolved: paired.filter(Boolean).length,
      pageTextLength: answerText.length,
      triples: allTriples,
    });
    if (!positional) {
      const salvaged = paired.filter(Boolean).length;
      debug(
        `runBatch: got ${allTriples.length} answer line(s) for ${items.length} companies - ` +
          `matched ${salvaged} by company name, recording the other ${items.length - salvaged} as not_found`
      );
    }

    const results = items.map((it, idx) => {
      const parsed = paired[idx];
      if (parsed && (parsed.website || parsed.rating !== null)) {
        return {
          itemId: it.itemId,
          status: parsed.rating !== null ? "found" : "not_found",
          website: parsed.website,
          source: parsed.website ? "ai_mode" : null,
          rating: parsed.rating,
          ratingReason: parsed.reason,
        };
      }
      // No usable line for this company. Solo retries are deliberately NOT
      // used any more (see the batch-retry block above): this is final.
      return { itemId: it.itemId, status: "not_found" };
    });

    const resolved = results.filter((r) => r.status === "found").length;
    debug(`runBatch: reporting ${resolved} rated / ${results.length - resolved} not rated`);
    chrome.runtime.sendMessage({ type: "RESULT", batchToken, results });
  }

  // background.js sends this when a batch is nearing its watchdog deadline
  // with nothing reported yet. In a hidden/minimised tab the timers that would
  // normally end the wait may be throttled to a crawl - but message delivery
  // is not, so this is the reliable way to say "stop waiting and tell me what
  // you've got", which beats letting the watchdog write the batch off.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== "REPORT_NOW") return;
    const waiting = typeof nudgeNow === "function";
    debug("REPORT_NOW received", waiting ? "- ending the wait now" : "- not currently waiting");
    if (waiting) nudgeNow();
    sendResponse({ waiting });
  });

  run();
})();
