/* ============================================================
 * Parsian (پارسیان) — Persian Proofreading Engine v1.0
 * نسل جدید موتور ویراستاری، الهام‌گرفته از Virastyar (GPL)
 * با ساختار دادهٔ هش‌شده و بررسی خطی سریع
 * License: GPL-3.0 (open source)
 * ============================================================ */
(function (global) {
  'use strict';

  var ZWNJ = '\u200c', NBSP = '\u00a0';

  // ---------------- Data (loaded from JSON) ----------------
  var D = {
    dic: {},            // word -> [freq, pos]
    verbs: [],          // {past, present}
    verbSet: new Set(),
    verbPresentSet: new Set(),
    exceptions: [],     // {flags, wrong, sugg}
    patterns: [],       // {pattern, message, action, replacement}
    userWords: new Set(),
    ignoredAll: new Set(),   // word -> ignored for this session (whole text)
    changeAll: {}       // wrong -> replacement (whole text)
  };

  var NONWORD_STEM = ['ها', 'های', 'هایی', 'تر', 'ترین', 'ام', 'ات', 'اش'];

  function loadDictionary(obj) {
    D.dic = obj || {};
  }
  function loadVerbs(arr) {
    D.verbs = arr || [];
    D.verbSet = new Set(D.verbs.map(function (v) { return v.past; }));
    D.verbPresentSet = new Set(D.verbs.map(function (v) { return v.present; }));
  }
  function loadExceptions(arr) {
    D.exceptions = arr || [];
    D.excMap = {};
    D.exceptions.forEach(function (e) {
      if (!D.excMap[e.wrong]) D.excMap[e.wrong] = [];
      e.sugg.forEach(function (s) { D.excMap[e.wrong].push(s); });
    });
  }
  function loadPatterns(arr) { D.patterns = arr || []; }

  // ---------------- Character helpers ----------------
  var PERSIAN_LETTER = /[\u0621-\u064A\u0671-\u06D3\u200c]/;

  function isPersianWordChar(ch) {
    return /[\u0621-\u064A\u0671-\u06D3]/.test(ch) || ch === ZWNJ;
  }

  function normalizeArabic(w) {
    return w.replace(/\u064A/g, '\u06CC')   // ي -> ی
            .replace(/\u0643/g, '\u06A9')   // ك -> ک
            .replace(/\u0629/g, '\u0647');  // ة -> ه
  }

  // ---------------- Tokenizer ----------------
  // returns [{text, start, end}] for word-like tokens (letters + ZWNJ inside)
  function tokenize(text) {
    var tokens = [], i = 0, n = text.length;
    while (i < n) {
      var ch = text[i];
      if (/[\u0621-\u06D3]/.test(ch)) {
        var j = i + 1;
        while (j < n && (/[\u0621-\u06D3]/.test(text[j]) || (text[j] === ZWNJ && j + 1 < n && /[\u0621-\u06D3]/.test(text[j + 1])))) j++;
        tokens.push({ text: text.slice(i, j), start: i, end: j });
        i = j;
      } else {
        i++;
      }
    }
    return tokens;
  }

  // ---------------- Word lookup ----------------
  function inDictionary(word) {
    if (D.userWords.has(word)) return true;
    if (D.dic[word] !== undefined) return true;
    var norm = normalizeArabic(word);
    if (D.dic[norm] !== undefined) return true;
    // try replacing ZWNJ with space (compound words may be split in dict)
    if (word.indexOf(ZWNJ) >= 0) {
      var spaced = word.split(ZWNJ).join(' ');
      if (D.dic[spaced] !== undefined) return true;
      var parts = word.split(ZWNJ);
      if (parts.length > 1 && parts.every(function (p) { return p && (D.dic[p] !== undefined || D.userWords.has(p)); })) return true;
    }
    return false;
  }


  // Verb-aware recognition: past/present stems + personal endings
  var PAST_ENDINGS = ['ند', 'ید', 'یم', '\u200cاید', 'م', 'ی', 'ه'];
  var PRES_ENDINGS = ['ند', 'ید', 'یم', 'م', 'ی', 'د'];
  var VERB_PREFIXES = ['نمی\u200c', 'می\u200c', 'همی\u200c', 'بی\u200c'];

  function stripEndings(w, stems, endings) {
    if (stems.has(w)) return true;
    for (var e = 0; e < endings.length; e++) {
      var suf = endings[e];
      if (w.length > suf.length && w.slice(-suf.length) === suf && stems.has(w.slice(0, -suf.length))) return true;
    }
    return false;
  }

  function isVerbForm(w) {
    if (stripEndings(w, D.verbSet, PAST_ENDINGS)) return true;
    // bare 3rd-person present forms: گوید، باشد، باشید
    if (stripEndings(w, D.verbPresentSet, PRES_ENDINGS)) return true;
    // negative verb: ن + (past or present form)
    if (w[0] === 'ن' && w.length > 2) {
      var x = w.slice(1);
      if (stripEndings(x, D.verbSet, PAST_ENDINGS)) return true;
      if (stripEndings(x, D.verbPresentSet, PRES_ENDINGS)) return true;
    }
    // strip prefix(es) like می/نمی then test present stem
    var rest = w;
    for (var p = 0; p < VERB_PREFIXES.length; p++) {
      var pre = VERB_PREFIXES[p];
      if (rest.slice(0, pre.length) === pre) {
        rest = rest.slice(pre.length);
        if (stripEndings(rest, D.verbPresentSet, PRES_ENDINGS)) return true;
        // euphonic ی: گو + ی + د
        if (rest.length > 1 && rest[0] === 'ی' && stripEndings(rest.slice(1), D.verbPresentSet, PRES_ENDINGS)) return true;
        break;
      }
    }
    // imperative/negative imperative: بگو، نگو
    if (rest !== w) return false;
    if (w[0] === 'ب' && stripEndings(w.slice(1), D.verbPresentSet, PRES_ENDINGS)) return true;
    if ((w[0] === 'ن' || w[0] === 'ب') && w[1] === 'ب' && stripEndings(w.slice(2), D.verbPresentSet, PRES_ENDINGS)) return true;
    return false;
  }

  function knownWord(word) {
    if (inDictionary(word)) return true;
    if (isVerbForm(word)) return true;
    return false;
  }

  function isException(word) {
    var e = D.excMap && D.excMap[word];
    if (!e) return false;
    // flags like "NCasensitive" — currently all treated as skip-list entries
    return true;
  }

  // ---------------- Spell check for one word ----------------
  function checkWord(word) {
    if (!word || word.length < 2) return null;
    if (knownWord(word)) return null;
    if (isException(word)) return null;
    if (D.ignoredAll.has(word)) return null;
    if (D.changeAll[word] !== undefined) {
      return { word: word, suggestions: [D.changeAll[word]], auto: D.changeAll[word], reason: 'اصلاح یکباره' };
    }
    var sug = suggest(word);
    var reason = 'واژه در واژه‌نامه یافت نشد';
    if (/^(نمی|می)/.test(word) && word.indexOf(ZWNJ) < 0) reason = 'پیشوند «می/نمی» باید با نیم‌فاصله از بن فعل جدا شود';
    return { word: word, suggestions: sug, auto: sug[0] || null, reason: reason };
  }

  // ---------------- Suggestion generator ----------------
  function suggest(word) {
    var found = {}, order = [];

    // 0a. می/نمی without ZWNJ — best fix is inserting ZWNJ
    var mPre = word.match(/^(نمی|می)([\u0621-\u06D3]+)$/);
    if (mPre && isVerbForm(mPre[2])) {
      add(mPre[1] + ZWNJ + mPre[2]);
      return order.slice(0, 8);
    }
    function compoundOK(w) {
      if (w.indexOf(ZWNJ) < 0) return false;
      var parts = w.split(ZWNJ);
      return parts.length > 1 && parts.every(function (p) {
        return p.length > 0 && (D.dic[p] !== undefined || D.userWords.has(p) ||
          NONWORD_STEM.indexOf(p) >= 0 || D.verbSet.has(p) || D.verbPresentSet.has(p));
      });
    }
    function add(w) {
      if (!w || w === word) return;
      if (!found[w] && (inDictionary(w) || isVerbForm(w) || compoundOK(w) || /[\u0621-\u06D3] [\u0621-\u06D3]/.test(w))) { found[w] = true; order.push(w); }
    }

    // 0. best split into two dictionary words (stuck-words suggestion)
    var endsWithSuffix = NONWORD_STEM.some(function (s) { return word.slice(-s.length) === s; });
    if (word.indexOf(ZWNJ) < 0 && word.length >= 5 && !endsWithSuffix) {
      var best = null;
      for (var si = 2; si < word.length - 1; si++) {
        var sa = word.slice(0, si), sb = word.slice(si);
        if ((D.dic[sa] || D.userWords.has(sa)) && (D.dic[sb] || D.userWords.has(sb))) {
          if (NONWORD_STEM.indexOf(sa) >= 0) continue;
          var zwnjForm = sa + ZWNJ + sb;
          best = inDictionary(zwnjForm) ? zwnjForm : (sa + ' ' + sb);
          break;
        }
      }
      if (best) { add(best); return order.slice(0, 8); }
    }

    // 1. spacing fusion / split candidates
    // split candidate: maybe the word lost its ZWNJ -> add ZWNJ before suffix
    NONWORD_STEM.forEach(function (suf) {
      if (word.length > suf.length && word.slice(-suf.length) === suf) {
        add(word.slice(0, -suf.length) + ZWNJ + suf);
        add(word.slice(0, -suf.length) + ' ' + suf);
      }
    });
    if (order.length) return order.slice(0, 8);

    // 2. try replacing spaces inside (adjacent words stuck together)
    if (word.indexOf(ZWNJ) < 0) {
      for (var i = 2; i < word.length - 1; i++) {
        var a = word.slice(0, i), b = word.slice(i);
        if ((D.dic[a] || D.userWords.has(a)) && (D.dic[b] || D.userWords.has(b))) {
          add(a + ' ' + b);
          if (order.length > 12) break;
        }
      }
    }

    // 3. verb candidates: "می" stuck, "نمی" stuck, or missing ZWNJ before verb
    if (D.verbSet.has(word) || D.verbPresentSet.has(word)) {
      add('می' + ZWNJ + word);
      add('نمی' + ZWNJ + word);
    }
    if (word.slice(0, 2) === 'می' && word.length > 2) {
      add('می' + ZWNJ + word.slice(2));
      add(word.slice(2));
    }
    if (word.slice(0, 3) === 'نمی' && word.length > 3) {
      add('نمی' + ZWNJ + word.slice(3));
      add(word.slice(3));
    }
    if (word.indexOf('می' + ZWNJ) === 0) add(word.slice(3));
    if (word.indexOf('نمی' + ZWNJ) === 0) add(word.slice(4));

    // 4. exception-driven (e.g. latin confusions)
    if (D.excMap && D.excMap[word]) D.excMap[word].forEach(add);

    // 5. suffix strip: word = stem+suffix -> suggest stem alone
    NONWORD_STEM.forEach(function (suf) {
      if (word.length > suf.length && word.slice(-suf.length) === suf) add(word.slice(0, -suf.length));
    });

    // 6. edit distance 1 over dictionary (fast: operate on chars, lookup only)
    editDistanceSuggestions(word, add);

    return order.slice(0, 8);
  }

  function editDistanceSuggestions(word, add) {
    var letters = 'ابپتثجچحخدذرزژسشصضطظعغفقکگلمنوهیآأإءئ';
    var i, c;
    // deletions
    for (i = 0; i < word.length; i++) add(word.slice(0, i) + word.slice(i + 1));
    // substitutions
    for (i = 0; i < word.length; i++) {
      for (c = 0; c < letters.length; c++) {
        if (letters[c] !== word[i]) add(word.slice(0, i) + letters[c] + word.slice(i + 1));
      }
    }
    // transposition
    for (i = 0; i < word.length - 1; i++) {
      if (word[i] !== word[i + 1]) add(word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2));
    }
    // Ya/Kaf normalization variants
    add(normalizeArabic(word));
  }

  // ---------------- Prefix/suffix analysis (with ZWNJ) ----------------
  var PREFIXES = ['می', 'نمی', 'بی', 'هم', 'نا', 'بی‌'];
  var SUFFIX_ZWNJ = ['ها', 'های', 'هایی', 'ام', 'ات', 'اش', 'تر', 'ترین', 'مان', 'تان', 'شان'];

  // detect words that SHOULD carry ZWNJ before suffix but have plain adjacency or wrong space
  function checkAffixIssues(text, tokens) {
    var issues = [];
    tokens.forEach(function (t) {
      var w = t.text;
      if (!inDictionary(w)) {
        // word not in dict: try to fix by inserting ZWNJ before suffix
        for (var k = 0; k < SUFFIX_ZWNJ.length; k++) {
          var suf = SUFFIX_ZWNJ[k];
          if (w.length > suf.length + 1 && w.slice(-suf.length) === suf && w[w.length - suf.length - 1] !== ZWNJ) {
            var stem = w.slice(0, -suf.length);
            var fixed = stem + ZWNJ + suf;
            if (inDictionary(stem) && (inDictionary(fixed) || D.dic[suf] !== undefined)) {
              issues.push({
                kind: 'affix', start: t.start, end: t.end, word: w,
                message: 'پسوند باید با نیم‌فاصله جدا شود (تشخیص و اصلاح واژه‌های با پسوند)',
                suggestions: [fixed], auto: fixed
              });
              break;
            }
          }
        }
      }
    });
    return issues;
  }

  // ---------------- Pattern-based spacing/punctuation checks ----------------
  function checkPatterns(text) {
    var issues = [];
    D.patterns.forEach(function (p) {
      var re;
      try { re = new RegExp(p.pattern, 'gm'); } catch (e) { return; }
      var m;
      var count = 0;
      while ((m = re.exec(text)) !== null) {
        if (m[0].length === 0) { re.lastIndex++; continue; }
        var replacement = expandReplacement(p.replacement, m);
        if (replacement !== m[0]) {
          issues.push({
            kind: 'pattern', start: m.index, end: m.index + m[0].length,
            text: m[0], message: p.message, suggestions: [replacement], auto: replacement
          });
        }
        if (++count > 2000) break; // safety
      }
    });
    return issues;
  }

  function expandReplacement(rep, m) {
    return rep.replace(/\$(\d)/g, function (_, d) {
      return m[parseInt(d, 10)] !== undefined ? m[parseInt(d, 10)] : '';
    }).replace(/\u0002/g, '');
  }

  // ---------------- Wrong space between letters of one word ----------------
  // e.g. «کتا ب» — single Persian letters separated by space that form a word when joined
  function checkWordSplitBySpace(text) {
    var issues = [];
    var re = /([\u0621-\u06D3]{1,3}) ([\u0621-\u06D3]{1,4})(?=[\s\.,،؛:!؟\)\»]|$)/g;
    var m;
    while ((m = re.exec(text)) !== null) {
      var joined = m[1] + m[2];
      if ((D.dic[joined] || D.userWords.has(joined)) && !(D.dic[m[1]] && D.dic[m[2]])) {
        issues.push({
          kind: 'space-in-word', start: m.index, end: m.index + m[0].length,
          text: m[0], message: 'درج فاصلهٔ اشتباه میان حروف یک واژه',
          suggestions: [joined], auto: joined
        });
      }
      if (issues.length > 500) break;
    }
    return issues;
  }

  // ---------------- Adjacent stuck words: word+word without space ----------------
  // long non-dictionary words that split into two dictionary words
  function checkStuckWords(tokens) {
    var issues = [];
    tokens.forEach(function (t) {
      var w = t.text;
      if (w.length < 5 || knownWord(w) || w.indexOf(ZWNJ) >= 0 || /^(نمی|می)/.test(w)) return;
      if (D.verbSet.has(w) || D.verbPresentSet.has(w)) return;
      // find split point maximizing both parts being real words
      for (var i = 2; i < w.length - 1; i++) {
        var a = w.slice(0, i), b = w.slice(i);
        if ((D.dic[a] || D.userWords.has(a)) && (D.dic[b] || D.userWords.has(b))) {
          // avoid false positives where a is a common short prefix of real words
          if (NONWORD_STEM.indexOf(a) >= 0) continue;
          var sug = a + ' ' + b;
          var sugZ = a + ZWNJ + b;
          var sugg = inDictionary(sugZ) ? [sugZ, sug] : [sug];
          issues.push({
            kind: 'stuck', start: t.start, end: t.end, word: w,
            message: 'چسبیدن واژه‌های متوالی به هم', suggestions: sugg, auto: sugg[0]
          });
          break;
        }
      }
    });
    return issues;
  }

  // ---------------- Main verifier ----------------
  // options: {spell:true, spacing:true, affix:true}
  function verify(text, options) {
    options = options || {};
    var o = { spell: true, spacing: true, affix: true };
    for (var k in options) o[k] = options[k];

    var t0 = (global.performance && performance.now()) || Date.now();
    var issues = [];

    var tokens = tokenize(text);

    if (o.spell) {
      tokens.forEach(function (t) {
        var r = checkWord(t.text);
        if (r) issues.push({
          kind: 'spell', start: t.start, end: t.end, word: t.text,
          message: 'واژه در واژه‌نامه یافت نشد', suggestions: r.suggestions, auto: r.auto
        });
      });
      if (o.affix) issues = issues.concat(checkAffixIssues(text, tokens));
      if (o.spacing) issues = issues.concat(checkStuckWords(tokens));
    }
    if (o.spacing) {
      issues = issues.concat(checkPatterns(text));
      issues = issues.concat(checkWordSplitBySpace(text));
    }

    // sort by position, remove overlapping (keep first)
    issues.sort(function (a, b) { return a.start - b.start || b.end - a.end; });
    var clean = [], lastEnd = -1;
    issues.forEach(function (it) {
      if (it.start >= lastEnd) { clean.push(it); lastEnd = it.end; }
    });

    var t1 = (global.performance && performance.now()) || Date.now();
    return { issues: clean, ms: Math.round((t1 - t0) * 10) / 10, tokenCount: tokens.length };
  }

  // ---------------- Apply fixes to text ----------------
  // action per issue: {replaceWith} or null(=skip)
  function applyFixes(text, issues, decisions) {
    // apply from end to start
    var sorted = issues.slice().sort(function (a, b) { return b.start - a.start; });
    var result = text;
    sorted.forEach(function (it, idx) {
      var dec = decisions ? decisions[idx] : undefined;
      var repl;
      if (dec === null || dec === undefined) repl = it.auto; // batch mode: auto fix
      else repl = dec;
      if (repl !== undefined && repl !== null) {
        result = result.slice(0, it.start) + repl + result.slice(it.end);
      }
    });
    return result;
  }

  // ---------------- Session controls ----------------
  function ignoreOnce() { /* handled at UI level: skip that issue */ }
  function ignoreAll(word) { D.ignoredAll.add(word); }
  function changeAll(wrong, right) { D.changeAll[wrong] = right; }
  function addToDictionary(word) { D.userWords.add(word); }
  function getUserWords() { return Array.from(D.userWords); }
  function setUserWords(arr) { D.userWords = new Set(arr || []); }
  function clearSession() { D.ignoredAll.clear(); D.changeAll = {}; }
  function dictionarySize() { return Object.keys(D.dic).length + D.userWords.size; }

  // ---------------- Export ----------------
  var ParsianEngine = {
    ZWNJ: ZWNJ,
    loadDictionary: loadDictionary,
    loadVerbs: loadVerbs,
    loadExceptions: loadExceptions,
    loadPatterns: loadPatterns,
    verify: verify,
    applyFixes: applyFixes,
    suggest: suggest,
    checkWord: checkWord,
    tokenize: tokenize,
    ignoreAll: ignoreAll,
    changeAll: changeAll,
    addToDictionary: addToDictionary,
    getUserWords: getUserWords,
    setUserWords: setUserWords,
    clearSession: clearSession,
    dictionarySize: dictionarySize
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = ParsianEngine;
  global.ParsianEngine = ParsianEngine;
})(typeof window !== 'undefined' ? window : globalThis);
