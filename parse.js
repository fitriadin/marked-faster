// marked-faster: a fast, dependency-free drop-in for marked 18.1.3's
// `marked.parse(markdown)` with default options (GFM on, async off).
//
// Original implementation, written from scratch for the make.fun
// "Make Markdown rendering faster" bounty. It reproduces marked's output
// byte for byte by following the same block/inline grammar and the same
// tokenizer decisions, but it is structured for speed: the block loop
// scans the source by index with sticky patterns (no per-block slicing of
// the remainder), blocks are kept as small records instead of token trees,
// and inline runs render straight to HTML strings.
//
// Behavioural credit: the grammar and the tokenizer semantics follow
// marked (MIT, https://github.com/markedjs/marked), which this module
// replaces; no marked source code is included here.

'use strict';

// ---------------------------------------------------------------- helpers

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const escapeTest = /[&<>"']/;
const escapeReplace = /[&<>"']/g;
const escapeTestNoEncode = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const escapeReplaceNoEncode = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function escapeHtml(html, encode) {
  if (encode) {
    if (escapeTest.test(html)) return html.replace(escapeReplace, (ch) => ESCAPE_MAP[ch]);
  } else if (escapeTestNoEncode.test(html)) {
    return html.replace(escapeReplaceNoEncode, (ch) => ESCAPE_MAP[ch]);
  }
  return html;
}

const numericRefTest = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const numericRefOrAmp = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function decodeNumericRefs(text) {
  if (!numericRefTest.test(text)) return text;
  return text.replace(numericRefOrAmp, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

const percentDecode = /%25/g;

function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(percentDecode, '%');
  } catch {
    return null;
  }
  return href;
}

const findPipe = /\|/g;
const splitPipe = / \|/;
const slashPipe = /\\\|/g;

function splitCells(tableRow, count) {
  const row = tableRow.replace(findPipe, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = row.split(splitPipe);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells.at(-1)?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(slashPipe, '|');
  return cells;
}

function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) return '';
  let suffLen = 0;
  while (suffLen < l) {
    const currChar = str.charAt(l - suffLen - 1);
    if (currChar === c && !invert) suffLen++;
    else if (currChar !== c && invert) suffLen++;
    else break;
  }
  return str.slice(0, l - suffLen);
}

const blankLineRe = /^[ \t]*$/;

function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && blankLineRe.test(lines[end])) end--;
  if (lines.length - end <= 2) return str;
  return lines.slice(0, end + 1).join('\n');
}

const multipleSpaceGlobal = /\s+/g;

function normalizeLabel(label) {
  return label.trim().replace(multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === b[0]) level++;
    else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  if (level > 0) return -2;
  return -1;
}

function expandTabs(line, indent = 0) {
  let col = indent;
  let expanded = '';
  for (const char of line) {
    if (char === '\t') {
      const added = 4 - (col % 4);
      expanded += ' '.repeat(added);
      col += added;
    } else {
      expanded += char;
      col++;
    }
  }
  return expanded;
}

// ------------------------------------------------------------ regex tools

const caretRe = /(^|[^\[])\^/g;

// Compose a pattern from pieces, the way marked's `edit` does: each
// replacement drops a leading `^` from the inserted piece.
function edit(regex, opt = '') {
  let source = typeof regex === 'string' ? regex : regex.source;
  const obj = {
    replace(name, val) {
      let valSource = typeof val === 'string' ? val : val.source;
      valSource = valSource.replace(caretRe, '$1');
      source = source.replace(name, valSource);
      return obj;
    },
    getRegex() {
      return new RegExp(source, opt);
    },
  };
  return obj;
}

// Turn an anchored (`^...`) pattern into a sticky one that matches at
// `lastIndex` instead of at the start of the string. Anchor carets are
// dropped (stickiness already anchors); carets inside character classes
// are kept. `$` still means end of the whole string, which is what the
// anchored originals meant on their sliced input.
function toSticky(re) {
  let out = '';
  let inClass = false;
  let esc = false;
  const s = re.source;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) { out += c; esc = false; continue; }
    if (c === '\\') { out += c; esc = true; continue; }
    if (c === '[') inClass = true;
    if (c === ']') inClass = false;
    if (c === '^' && !inClass && (i === 0 || s[i - 1] === '|')) continue;
    out += c;
  }
  let flags = re.flags.replace('g', '');
  if (!flags.includes('y')) flags += 'y';
  return new RegExp(out, flags);
}

// Run a sticky pattern at `pos` in `src`; returns the match or null.
function at(re, src, pos) {
  re.lastIndex = pos;
  return re.exec(src);
}

// ------------------------------------------------------------- block rules

const _tag = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';
const _comment = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;

const newlineRe = /^(?:[ \t]*(?:\n|$))+/;
const blockCodeRe = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const fencesRe = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const hrRe = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const headingRe = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const bulletRe = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const blockTextRe = /^[^\n]+/;

const lheadingCore = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const lheadingRe = edit(lheadingCore)
  .replace(/bull/g, bulletRe)
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/) // non-capturing here, so the underline stays group 2
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .getRegex();

const _blockLabel = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const defRe = edit(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .replace('label', _blockLabel)
  .replace('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .getRegex();

const listRe = edit(/^(bull)([ \t][^\n]*?)?(?:\n|$)/)
  .replace(/bull/g, bulletRe)
  .getRegex();

const htmlRe = edit(
  '^ {0,3}(?:'
  + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)'
  + '|comment[^\\n]*(\\n+|$)'
  + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)'
  + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)'
  + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)'
  + '|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + ')', 'i')
  .replace('comment', _comment)
  .replace('tag', _tag)
  .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .getRegex();

const gfmTableRe = edit(
  '^ *([^\\n ].*)\\n'
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
  + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)')
  .replace('hr', hrRe)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('blockquote', ' {0,3}>')
  .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', _tag)
  .getRegex();

const _paragraph = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;

function createParagraph(listInterrupt) {
  return edit(_paragraph)
    .replace('hr', hrRe)
    .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .replace('|lheading', '')
    .replace('|table', '')
    .replace('blockquote', ' {0,3}>')
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', listInterrupt)
    .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
    .replace('tag', _tag)
    .getRegex();
}

const paragraphRe = edit(_paragraph)
  .replace('hr', hrRe)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('|lheading', '')
  .replace('table', gfmTableRe)
  .replace('blockquote', ' {0,3}>')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', _tag)
  .getRegex();

const blockquoteParagraphRe = createParagraph(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/);

const blockquoteRe = edit(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/)
  .replace('paragraph', blockquoteParagraphRe)
  .getRegex();

// Sticky variants used by the index-based block loop.
const S_NEWLINE = toSticky(newlineRe);
const S_CODE = toSticky(blockCodeRe);
const S_FENCES = toSticky(fencesRe);
const S_HEADING = toSticky(headingRe);
const S_HR = toSticky(hrRe);
const S_BLOCKQUOTE = toSticky(blockquoteRe);
const S_LIST = toSticky(listRe);
const S_HTML = toSticky(htmlRe);
const S_DEF = toSticky(defRe);
const S_TABLE = toSticky(gfmTableRe);
const S_LHEADING = toSticky(lheadingRe);
const S_PARAGRAPH = toSticky(paragraphRe);
const S_TEXT = toSticky(blockTextRe);

// ------------------------------------------------------------ inline rules

const _punctuation = /[\p{P}\p{S}]/u;
const _punctuationOrSpace = /[\s\p{P}\p{S}]/u;
const _notPunctuationOrSpace = /[^\s\p{P}\p{S}]/u;
const _punctuationGfmStrongEm = /(?!~)[\p{P}\p{S}]/u;
const _punctuationOrSpaceGfmStrongEm = /(?!~)[\s\p{P}\p{S}]/u;
const _notPunctuationOrSpaceGfmStrongEm = /(?:[^\s\p{P}\p{S}]|~)/u;

const escapeRe = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const inlineCodeRe = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const brRe = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;

const punctuationRe = edit(/^((?![*_])punctSpace)/, 'u')
  .replace(/punctSpace/g, _punctuationOrSpace).getRegex();

const emStrongLDelimCore = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
const emStrongLDelimRe = edit(emStrongLDelimCore, 'u')
  .replace(/punct/g, _punctuationGfmStrongEm)
  .getRegex();

const emStrongRDelimAstCore =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)'
  + '|[^*]+(?=[^*])'
  + '|(?!\\*)punct(\\*+)(?=[\\s]|$)'
  + '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)'
  + '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)'
  + '|[\\s](\\*+)(?!\\*)(?=punct)'
  + '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)'
  + '|notPunctSpace(\\*+)(?=notPunctSpace)';

const emStrongRDelimAstRe = edit(emStrongRDelimAstCore, 'gu')
  .replace(/notPunctSpace/g, _notPunctuationOrSpaceGfmStrongEm)
  .replace(/punctSpace/g, _punctuationOrSpaceGfmStrongEm)
  .replace(/punct/g, _punctuationGfmStrongEm)
  .getRegex();

const emStrongRDelimUndRe = edit(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)'
  + '|[^_]+(?=[^_])'
  + '|(?!_)punct(_+)(?=[\\s]|$)'
  + '|notPunctSpace(_+)(?!_)(?=punctSpace|$)'
  + '|(?!_)punctSpace(_+)(?=notPunctSpace)'
  + '|[\\s](_+)(?!_)(?=punct)'
  + '|(?!_)punct(_+)(?!_)(?=punct)', 'gu')
  .replace(/notPunctSpace/g, _notPunctuationOrSpace)
  .replace(/punctSpace/g, _punctuationOrSpace)
  .replace(/punct/g, _punctuation)
  .getRegex();

const delLDelimRe = edit(/^~~?(?:((?!~)punct)|[^\s~])/, 'u')
  .replace(/punct/g, _punctuation)
  .getRegex();

const delRDelimCore =
  '^[^~]+(?=[^~])'
  + '|(?!~)punct(~~?)(?=[\\s]|$)'
  + '|notPunctSpace(~~?)(?!~)(?=punctSpace|$)'
  + '|(?!~)punctSpace(~~?)(?=notPunctSpace)'
  + '|[\\s](~~?)(?!~)(?=punct)'
  + '|(?!~)punct(~~?)(?!~)(?=punct)'
  + '|notPunctSpace(~~?)(?=notPunctSpace)';

const delRDelimRe = edit(delRDelimCore, 'gu')
  .replace(/notPunctSpace/g, _notPunctuationOrSpace)
  .replace(/punctSpace/g, _punctuationOrSpace)
  .replace(/punct/g, _punctuation)
  .getRegex();

// The `^`-anchored first alternatives of the right-delimiter scans, as
// sticky patterns: they can only match at the start of the closer window,
// so the scan checks them once up front and then runs the global pattern
// from there on the un-sliced source.
const emStrongRDelimAstFirst = /[^_*]*?__[^_*]*?\*[^_*]*?(?=__)/yu;
const emStrongRDelimUndFirst = /[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)/yu;
const delRDelimFirst = /[^~]+(?=[^~])/y;

const anyPunctuationRe = edit(/\\(punct)/, 'gu')
  .replace(/punct/g, _punctuation)
  .getRegex();

const anyPunctuationOutsideCodeRe = edit(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu')
  .replace(/punct/g, _punctuation)
  .getRegex();

const autolinkRe = edit(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .replace('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
  .getRegex();

const _inlineComment = edit(_comment).replace('(?:-->|$)', '-->').getRegex();
const tagRe = edit(
  '^comment'
  + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>'
  + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>'
  + '|^<\\?[\\s\\S]*?\\?>'
  + '|^<![a-zA-Z]+\\s[\\s\\S]*?>'
  + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>')
  .replace('comment', _inlineComment)
  .replace('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
  .getRegex();

const _inlineLabelBrackets = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const _inlineLabel = edit(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
  .replace('brackets', _inlineLabelBrackets)
  .getRegex();

const linkRe = edit(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .replace('label', _inlineLabel)
  .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .replace('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .getRegex();

const reflinkRe = edit(/^!?\[(label)\]\[(ref)\]/)
  .replace('label', _inlineLabel)
  .replace('ref', _blockLabel)
  .getRegex();

const nolinkRe = edit(/^!?\[(ref)\](?:\[\])?/)
  .replace('ref', _blockLabel)
  .getRegex();

const _boundedBlockLabel = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const _boundedInlineLabel = edit(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/)
  .replace('brackets', _inlineLabelBrackets)
  .getRegex();

const reflinkSearchRe = edit('reflink|nolink(?!\\()', 'g')
  .replace('reflink', edit(/^!?\[(label)\]\[(ref)\]/)
    .replace('label', _boundedInlineLabel)
    .replace('ref', _boundedBlockLabel)
    .getRegex())
  .replace('nolink', edit(/^!?\[(ref)\](?:\[\])?/)
    .replace('ref', _boundedBlockLabel)
    .getRegex())
  .getRegex();

const blockSkipRe = edit(/link|precode-code|html/, 'g')
  .replace('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .replace('precode-', '(?<!`)()')
  .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace('html', /<(?! )[^<>]*?>/)
  .getRegex();

const _caseInsensitiveProtocol = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const _extendedEmail = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const _extendedEmailProtocol = edit(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/)
  .replace(/email/g, _extendedEmail)
  .getRegex();

const urlRe = edit(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .replace('emailProtocol', _extendedEmailProtocol)
  .replace('protocol', _caseInsensitiveProtocol)
  .replace('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
  .getRegex();

const backpedalRe = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

const inlineTextRe = edit(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
  .replace('protocol', _caseInsensitiveProtocol)
  .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
  .replace('wwwStart', '(?<![^\\s*_~(])www\\.')
  .getRegex();

// Sticky variants used by the index-based inline loop.
const S_ESCAPE = toSticky(escapeRe);
const S_TAG = toSticky(tagRe);
const S_LINK = toSticky(linkRe);
const S_REFLINK = toSticky(reflinkRe);
const S_NOLINK = toSticky(nolinkRe);
const S_EM_STRONG_LDELIM = toSticky(emStrongLDelimRe);
const S_DEL_LDELIM = toSticky(delLDelimRe);
const S_CODESPAN = toSticky(inlineCodeRe);
const S_BR = toSticky(brRe);
const S_AUTOLINK = toSticky(autolinkRe);
const S_URL = toSticky(urlRe);
const S_INLINE_TEXT = toSticky(inlineTextRe);

// ------------------------------------------------------- shared mini-rules

const codeRemoveIndent = /^(?: {0,3}\t| {1,4})/gm;
const indentCodeCompensationRe = /^(\s+)(?:```)/;
const beginningSpace = /^\s+/;
const endingHash = /#$/;
const startingSpaceChar = /^ /;
const endingSpaceChar = / $/;
const endingSpaceTabChar = /[ \t]$/;
const nonSpaceChar = /[^ ]/;
const newLineCharGlobal = /\n/g;
const tabCharGlobal = /\t/g;
const leadingSpaceTab = /^[ \t]+/;
const doubleBlankLine = /\n[ \t]*\n[ \t]*$/;
const blockquoteStart = /^ {0,3}>/;
const blockquoteSetextReplace = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const blockquoteSetextReplace2 = /^ {0,3}>[ \t]?/gm;
const blockquoteMarkerWhitespace = /^( {0,3}>)([ \t]+)/gm;
const listIsTask = /^\[[ xX]\][ \t]+\S/;
const listReplaceTask = /^\[[ xX]\][ \t]+/;
const listTaskCheckbox = /\[[ xX]\]/;
const anyLine = /\n.*\n/;
const hrefBrackets = /^<(.*)>$/;
const tableDelimiter = /[:|]/;
const tableAlignChars = /^\||\| *$/g;
const tableRowBlankLine = /\n[ \t]*$/;
const tableAlignRight = /^ *-+: *$/;
const tableAlignCenter = /^ *:-+: *$/;
const tableAlignLeft = /^ *:-+ *$/;
const startATag = /^<a /i;
const endATag = /^<\/a>/i;
const startPreScriptTag = /^<(pre|code|kbd|script)(\s|>)/i;
const endPreScriptTag = /^<\/(pre|code|kbd|script)(\s|>)/i;
const startAngleBracket = /^</;
const endAngleBracket = />$/;
const unicodeAlphaNumeric = /[\p{L}\p{N}]/u;
const notSpaceStart = /^\S*/;
const endingNewline = /\n$/;
const outputLinkReplace = /\\([\[\]])/g;
const carriageReturn = /\r\n|\r/g;
const setextLine = /^ {0,3}(?:=+|-+) *$/;
const leading3Spaces = /^ {0,3}/;

const listItemRes = new Map();
function listItemRegex(bull) {
  let re = listItemRes.get(bull);
  if (!re) {
    re = toSticky(new RegExp(`^( {0,3}${bull})((?:[\t ][^\\n]*)?(?:\\n|$))`));
    listItemRes.set(bull, re);
  }
  return re;
}

// The per-indent list helpers clamp indent-1 into 0..3 (marked's cache), so
// there are only four of each; build them once instead of per list item.
function clampIndent(indent) {
  return Math.max(0, Math.min(3, indent - 1));
}
const nextBulletRes = [];
const hrLineRes = [];
const fencesBeginRes = [];
const headingBeginRes = [];
const htmlBeginRes = [];
const blockquoteBeginRes = [];
for (let i = 0; i < 4; i++) {
  nextBulletRes.push(new RegExp(`^ {0,${i}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`));
  hrLineRes.push(new RegExp(`^ {0,${i}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`));
  fencesBeginRes.push(new RegExp(`^ {0,${i}}(?:\`\`\`|~~~)`));
  headingBeginRes.push(new RegExp(`^ {0,${i}}#{1,6}(?:\\s|$)`));
  htmlBeginRes.push(new RegExp(`^ {0,${i}}(?:</?(?:${_tag})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
  blockquoteBeginRes.push(new RegExp(`^ {0,${i}}>`));
}

// True when the leading whitespace of `line` contains a tab (the only case
// where tab expansion changes the line).
function hasLeadingTab(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\t') return true;
    if (c !== ' ') return false;
  }
  return false;
}

// ---------------------------------------------------------- inline parsing
//
// One parse's mutable state lives in `P` (fresh per parse() call):
//   links: link reference definitions (normalized label -> {href, title})
//   top: whether the block loop is at a top-level position
//   inLink / inRawBlock / linkEmitted / linkParenPossible: inline state
//   queue: block records holding inline runs, in lex order (checkbox fixups)

function firstCpLen(s) {
  const c = s.charCodeAt(0);
  if (c >= 0xd800 && c <= 0xdbff && s.length > 1) {
    const c2 = s.charCodeAt(1);
    if (c2 >= 0xdc00 && c2 <= 0xdfff) return 2;
  }
  return 1;
}

// Last index of a `*` / `_` / `~` run that can close emphasis, strong or
// strikethrough: a run counts only when not preceded by whitespace.
function scanClosers(src) {
  let star = -1;
  let under = -1;
  let tilde = -1;
  const len = src.length;
  for (let i = 0; i < len; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < len && src[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') tilde = i;
      else if (ch === '*') star = i;
      else under = i;
    }
    i = j - 1;
  }
  return { star, under, tilde };
}

function linkInText(P, text) {
  if (!text.includes('[')) return false;
  for (const match of text.matchAll(blockSkipRe)) {
    if (linkRe.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
  }
  for (const match of text.matchAll(reflinkSearchRe)) {
    const match0 = match[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!' || !Object.hasOwn(P.links, normalizeLabel(match0.slice(refStart + 1, -1)))) continue;
    if (refStart > 1 && linkInText(P, match0.slice(1, refStart - 1))) continue;
    return true;
  }
  return false;
}

// Mask links, code spans, HTML and escapes (length-preserving) so the
// emphasis scans do not see delimiters inside them.
function maskSrc(P, src) {
  let masked = src;
  if (src.includes('[')) {
    const maskReflink = (match0) => {
      const refStart = match0.lastIndexOf('[');
      if (!Object.hasOwn(P.links, normalizeLabel(match0.slice(refStart + 1, -1)))) return match0;
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (linkInText(P, text)) {
          return '[' + text.replace(reflinkSearchRe, maskReflink)
            + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    masked = masked.replace(reflinkSearchRe, maskReflink);
  }
  if (src.includes('\\') || src.includes('`')) {
    masked = masked.replace(anyPunctuationOutsideCodeRe, (match0, code, punct) => {
      if (punct) return '+'.repeat(match0.length);
      if (code) return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
      return match0;
    });
  }
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    masked = masked.replace(blockSkipRe, (match0) => '[' + 'a'.repeat(match0.length - 2) + ']');
  }
  return masked;
}

function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const code = at(S_CODESPAN, label, i);
      if (code) { i += code[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const token = at(S_TAG, src, labelStart + i) || at(S_AUTOLINK, src, labelStart + i);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

// Parse one inline run. `mode` is 'html' or 'text' (plain text, for image
// alt attributes); tokenization is identical, only the emitted strings
// differ. Returns the rendered string.
function inline(P, src, mode) {
  const prev = P.linkParenPossible;
  P.linkParenPossible = prev && src.includes(')');
  const out = inlineInner(P, src, mode);
  P.linkParenPossible = prev;
  return out;
}

// A top-level inline run (a block's own text): an unclosed <pre>/<code>/
// <kbd>/<script> does not leak into the next block.
function inlineTop(P, src) {
  P.inRawBlock = false;
  return inline(P, src, 'html');
}

function inlineInner(P, src, mode) {
  const hasEm = src.includes('*') || src.includes('_') || src.includes('~');
  const masked = hasEm ? maskSrc(P, src) : src;
  const closers = hasEm ? scanClosers(masked) : null;
  return tokenizeInlines(P, src, masked, closers, mode);
}

function emStrong(P, src, masked, pos, prevChar, closers, mode, out) {
  const match = at(S_EM_STRONG_LDELIM, src, pos);
  if (!match) return 0;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return 0;

  const delimChar = match[0][0];
  const midRun = prevChar === delimChar;
  const srcStart = pos;
  let runStart = srcStart;
  while (runStart > 0 && masked[runStart - 1] === delimChar) runStart--;

  let runPrevChar = '';
  if (runStart > 0) {
    const c1 = masked.charCodeAt(runStart - 1);
    if (c1 >= 0xdc00 && c1 <= 0xdfff && runStart >= 2) {
      const c0 = masked.charCodeAt(runStart - 2);
      runPrevChar = (c0 >= 0xd800 && c0 <= 0xdbff)
        ? masked.slice(runStart - 2, runStart)
        : masked[runStart - 1];
    } else {
      runPrevChar = masked[runStart - 1];
    }
  }
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_'
    || (runPrevChar !== '' && punctuationRe.test(runPrevChar));
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart
    ? runPrevPunct
    : (prevChar !== '' && punctuationRe.test(prevChar));

  if (match[4] && prevChar !== '' && unicodeAlphaNumeric.test(prevChar)) return 0;

  const nextChar = match[1] || match[3] || '';

  if (!nextChar || !prevChar || prevPunct) {
    let lLength = 0;
    while (lLength < match[0].length && match[0][lLength] === delimChar) lLength++;
    let rDelim;
    let rLength;
    let delimTotal = lLength;
    let midDelimTotal = 0;

    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim()
      && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return 0;
    const endReg = delimChar === '*' ? emStrongRDelimAstRe : emStrongRDelimUndRe;
    const lastPossible = delimChar === '*' ? closers.star : closers.under;
    const windowStart = pos + lLength;
    if (lastPossible < windowStart) return 0;

    const firstRe = delimChar === '*' ? emStrongRDelimAstFirst : emStrongRDelimUndFirst;
    let scanPos = windowStart;
    const firstMatch = at(firstRe, masked, windowStart);
    if (firstMatch) scanPos = windowStart + firstMatch[0].length;
    endReg.lastIndex = scanPos;

    let m;
    while ((m = endReg.exec(masked)) !== null) {
      if (m.index > lastPossible) break;
      rDelim = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
      if (!rDelim) continue;
      rLength = rDelim.length;

      if (m[3] || m[4]) {
        delimTotal += rLength;
        continue;
      } else if (m[5] || m[6] || openerCanClose) {
        if (midRun && (m[5] || m[6])) break;
        if (runLength % 3 && !((runLength + rLength) % 3)) {
          midDelimTotal += rLength;
          continue;
        }
      }

      delimTotal -= rLength;
      if (delimTotal > 0) continue;

      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = firstCpLen(m[0]);
      const rawLen = lLength + (m.index - windowStart) + lastCharLength + rLength;

      if (Math.min(lLength, rLength) % 2) {
        const inner = inline(P, src.slice(pos + 1, pos + rawLen - 1), mode);
        out.s += mode === 'text' ? inner : '<em>' + inner + '</em>';
        return rawLen;
      }
      const inner = inline(P, src.slice(pos + 2, pos + rawLen - 2), mode);
      out.s += mode === 'text' ? inner : '<strong>' + inner + '</strong>';
      return rawLen;
    }
  }
  return 0;
}

function tryDel(P, src, masked, pos, prevChar, closers, mode, out) {
  const match = at(S_DEL_LDELIM, src, pos);
  if (!match) return 0;

  const nextChar = match[1] || '';

  if (!nextChar || !prevChar || (prevChar !== '' && punctuationRe.test(prevChar))) {
    const lLength = match[0][1] === '~' ? 2 : 1;
    let rDelim;
    let rLength;
    let delimTotal = lLength;

    const lastPossible = closers.tilde;
    const windowStart = pos + lLength;
    if (lastPossible < windowStart) return 0;

    let scanPos = windowStart;
    const firstMatch = at(delRDelimFirst, masked, windowStart);
    if (firstMatch) scanPos = windowStart + firstMatch[0].length;
    delRDelimRe.lastIndex = scanPos;

    let m;
    while ((m = delRDelimRe.exec(masked)) !== null) {
      if (m.index > lastPossible) break;
      rDelim = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
      if (!rDelim) continue;
      rLength = rDelim.length;
      if (rLength !== lLength) continue;

      if (m[3] || m[4]) {
        delimTotal += rLength;
        continue;
      }

      delimTotal -= rLength;
      if (delimTotal > 0) continue;

      rLength = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = firstCpLen(m[0]);
      const rawLen = lLength + (m.index - windowStart) + lastCharLength + rLength;
      const inner = inline(P, src.slice(pos + lLength, pos + rawLen - lLength), mode);
      out.s += mode === 'text' ? inner : '<del>' + inner + '</del>';
      return rawLen;
    }
  }
  return 0;
}

function outputLink(P, labelText, href, title, raw, isImage, mode, out) {
  const text = labelText.replace(outputLinkReplace, '$1');
  const outerInLink = P.inLink;
  const outerLinkEmitted = P.linkEmitted;
  const outerInRawBlock = P.inRawBlock;
  P.inLink = true;
  P.linkEmitted = false;
  const inner = inline(P, text, isImage ? 'text' : mode);
  const textHasLink = P.linkEmitted;
  P.linkEmitted = outerLinkEmitted;
  P.inLink = outerInLink;

  if (!isImage) {
    // Links may not contain other links: bail so the caller falls through
    // to text and the inner link is the one kept. Images are exempt.
    if (textHasLink) {
      P.inRawBlock = outerInRawBlock;
      return 0;
    }
    P.linkEmitted = true;
  }

  if (mode === 'text') {
    out.s += inner;
    return raw.length;
  }
  if (isImage) {
    const cleanHref = cleanUrl(href);
    if (cleanHref === null) {
      out.s += escapeHtml(inner);
      return raw.length;
    }
    let tag = '<img src="' + escapeHtml(cleanHref) + '" alt="' + escapeHtml(inner) + '"';
    if (title) tag += ' title="' + escapeHtml(title) + '"';
    tag += '>';
    out.s += tag;
    return raw.length;
  }
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) {
    out.s += inner;
    return raw.length;
  }
  let tag = '<a href="' + escapeHtml(cleanHref) + '"';
  if (title) tag += ' title="' + escapeHtml(title) + '"';
  tag += '>' + inner + '</a>';
  out.s += tag;
  return raw.length;
}

function tryEscape(P, src, pos, mode, out) {
  const cap = at(S_ESCAPE, src, pos);
  if (!cap) return 0;
  out.s += mode === 'text' ? cap[1] : escapeHtml(cap[1]);
  return cap[0].length;
}

function tryTag(P, src, pos, out) {
  const cap = at(S_TAG, src, pos);
  if (!cap) return 0;
  if (!P.inLink && startATag.test(cap[0])) P.inLink = true;
  else if (P.inLink && endATag.test(cap[0])) P.inLink = false;
  if (!P.inRawBlock && startPreScriptTag.test(cap[0])) P.inRawBlock = true;
  else if (P.inRawBlock && endPreScriptTag.test(cap[0])) P.inRawBlock = false;
  out.s += cap[0];
  return cap[0].length;
}

function tryLink(P, src, pos, mode, out) {
  if (P.linkParenPossible === false) return 0;
  const cap = at(S_LINK, src, pos);
  if (!cap) return 0;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(src, cap[1], pos + labelStart)) return 0;

  const trimmedUrl = cap[2].trim();
  if (startAngleBracket.test(trimmedUrl)) {
    if (!endAngleBracket.test(trimmedUrl)) return 0;
    const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
    if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return 0;
  } else {
    const lastParenIndex = findClosingBracket(cap[2], '()');
    if (lastParenIndex === -2) return 0;
    if (lastParenIndex > -1) {
      const start = cap[0].indexOf('!') === 0 ? 5 : 4;
      const linkLen = start + cap[1].length + lastParenIndex;
      cap[2] = cap[2].substring(0, lastParenIndex);
      cap[0] = cap[0].substring(0, linkLen).trim();
      cap[3] = '';
    }
  }
  const unescaped = rtrim(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - unescaped.length) % 2 === 0) return 0;

  let href = cap[2];
  const title = cap[3] ? cap[3].slice(1, -1) : '';
  href = href.trim();
  if (startAngleBracket.test(href)) href = href.slice(1, -1);
  return outputLink(
    P, cap[1],
    href ? href.replace(anyPunctuationRe, '$1') : href,
    title ? title.replace(anyPunctuationRe, '$1') : title,
    cap[0], cap[0].charAt(0) === '!', mode, out,
  );
}

function tryReflink(P, src, pos, mode, out) {
  const cap = at(S_REFLINK, src, pos) || at(S_NOLINK, src, pos);
  if (!cap) return 0;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(src, cap[1], pos + labelStart)) return 0;

  const link = P.links[normalizeLabel(cap[2] || cap[1])];
  if (!link) {
    const text = cap[0].charAt(0);
    out.s += mode === 'text' ? text : escapeHtml(text);
    return 1;
  }
  return outputLink(P, cap[1], link.href, link.title, cap[0], cap[0].charAt(0) === '!', mode, out);
}

function tryCodespan(P, src, pos, mode, out) {
  const cap = at(S_CODESPAN, src, pos);
  if (!cap) return 0;
  let text = cap[2].replace(newLineCharGlobal, ' ');
  const hasNonSpaceChars = nonSpaceChar.test(text);
  const hasSpaceCharsOnBothEnds = startingSpaceChar.test(text) && endingSpaceChar.test(text);
  if (hasNonSpaceChars && hasSpaceCharsOnBothEnds) text = text.substring(1, text.length - 1);
  out.s += mode === 'text' ? text : '<code>' + escapeHtml(text, true) + '</code>';
  return cap[0].length;
}

function tryBr(P, src, pos, mode, out) {
  const cap = at(S_BR, src, pos);
  if (!cap) return 0;
  if (mode !== 'text') out.s += '<br>';
  return cap[0].length;
}

function tryAutolink(P, src, pos, mode, out) {
  const cap = at(S_AUTOLINK, src, pos);
  if (!cap) return 0;
  let text;
  let href;
  if (cap[2] === '@') {
    text = cap[1];
    href = 'mailto:' + text;
  } else {
    text = cap[1];
    href = text;
  }
  if (mode === 'text') {
    out.s += text;
    return cap[0].length;
  }
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) {
    out.s += escapeHtml(text, true);
    return cap[0].length;
  }
  out.s += '<a href="' + escapeHtml(cleanHref, true) + '">' + escapeHtml(text, true) + '</a>';
  return cap[0].length;
}

function tryUrl(P, src, pos, mode, out) {
  const cap = at(S_URL, src, pos);
  if (!cap) return 0;
  let text;
  let href;
  if (cap[2] === '@') {
    text = cap[0];
    href = 'mailto:' + text;
  } else {
    let prevCapZero;
    do {
      prevCapZero = cap[0];
      cap[0] = backpedalRe.exec(cap[0])?.[0] ?? '';
    } while (prevCapZero !== cap[0]);
    text = cap[0];
    href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
  }
  if (mode === 'text') {
    out.s += text;
    return cap[0].length;
  }
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) {
    out.s += escapeHtml(text, true);
    return cap[0].length;
  }
  out.s += '<a href="' + escapeHtml(cleanHref, true) + '">' + escapeHtml(text, true) + '</a>';
  return cap[0].length;
}

const TEXT_STOP_RE = /[\\<!\[`*~_]|https?|ftp:\/\/|www\.| {2,}\n|mailto:|xmpp:|@/gi;

function isAlnumCode(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

// [a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]
function isEmailCharCode(code) {
  if (isAlnumCode(code)) return true;
  switch (code) {
    case 33: case 35: case 36: case 37: case 38: case 39: case 42: case 43:
    case 45: case 46: case 47: case 61: case 63: case 95: case 96: case 123:
    case 124: case 125: case 126:
      return true;
    default: return false;
  }
}

// End index of the inline text token starting at `pos`, replicating the
// GFM text rule without running its big lazy regex: the first character (or
// backtick/tilde run) is consumed, then the token runs to the earliest stop
// — a special character, a URL/email start, or a hard-break run. (Splitting
// a text token at an uppercase WWW./MAILTO: is harmless: tryUrl is
// case-sensitive there, so the text simply resumes as a second token.)
function scanTextEnd(src, pos, len) {
  const c0 = src.charCodeAt(pos);
  if (!isAlnumCode(c0)
    && (src.startsWith('mailto:', pos + 1) || src.startsWith('xmpp:', pos + 1))) {
    return pos + 1;
  }
  let q = pos + 1;
  const ch0 = src[pos];
  if (ch0 === '`' || ch0 === '~') {
    while (q < len && src[q] === ch0) q++;
  }
  if (q >= len) return q;
  const cq = src[q];
  if (cq === '`' || cq === '~') return q;
  if (cq === ' ' && src[q + 1] === ' ') {
    let j = q + 2;
    while (src[j] === ' ') j++;
    if (src[j] === '\n') return q;
  }
  if (isEmailCharCode(src.charCodeAt(q))) {
    let j = q;
    while (j < len && isEmailCharCode(src.charCodeAt(j))) j++;
    if (src[j] === '@') return q;
  }
  TEXT_STOP_RE.lastIndex = q;
  let m;
  while ((m = TEXT_STOP_RE.exec(src)) !== null) {
    const s = m.index;
    const t = m[0].charCodeAt(0);
    // Single special char, http(s), or ftp://: stop right before it.
    if (t === 92 || t === 60 || t === 33 || t === 91 || t === 96 || t === 42
      || t === 126 || t === 95 || t === 104 || t === 72 || t === 102 || t === 70) {
      return s;
    }
    if (t === 119 || t === 87) {
      // www.: only a stop when the preceding char is whitespace, *, _, ~ or (.
      const pc = src[s - 1];
      if (pc === '*' || pc === '_' || pc === '~' || pc === '(' || /\s/.test(pc)) return s;
      continue;
    }
    if (t === 32) {
      // Hard-break run: the match starts at the run's first space.
      return s;
    }
    if (t === 109 || t === 77 || t === 120 || t === 88) {
      // mailto:/xmpp:: only a stop when the preceding char is not alphanumeric.
      if (s > q && !isAlnumCode(src.charCodeAt(s - 1))) return s;
      continue;
    }
    // '@': an email stop only when an email-local run starts after q.
    let e = s - 1;
    while (e >= q && isEmailCharCode(src.charCodeAt(e))) e--;
    if (e < s - 1 && e + 1 > q) return e + 1;
  }
  return len;
}

function tokenizeInlines(P, src, masked, closers, mode) {
  const out = { s: '' };
  const len = src.length;
  let pos = 0;
  let keepPrevChar = false;
  let prevChar = '';
  while (pos < len) {
    if (!keepPrevChar) prevChar = '';
    keepPrevChar = false;
    const ch = src[pos];
    let n = 0;
    if (ch === '\\') {
      n = tryEscape(P, src, pos, mode, out) || tryBr(P, src, pos, mode, out);
    } else if (ch === '<') {
      n = tryTag(P, src, pos, out) || tryAutolink(P, src, pos, mode, out);
    } else if (ch === '[' || ch === '!') {
      n = tryLink(P, src, pos, mode, out) || tryReflink(P, src, pos, mode, out);
    } else if (ch === '*' || ch === '_') {
      n = emStrong(P, src, masked, pos, prevChar, closers, mode, out)
        || (ch === '_' && !P.inLink ? tryUrl(P, src, pos, mode, out) : 0);
    } else if (ch === '`') {
      n = tryCodespan(P, src, pos, mode, out);
    } else if (ch === ' ') {
      n = tryBr(P, src, pos, mode, out);
    } else if (ch === '~') {
      n = tryDel(P, src, masked, pos, prevChar, closers, mode, out);
    } else if (ch === '.' || ch === '+' || ch === '-'
      || (ch >= '0' && ch <= '9') || (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')) {
      n = !P.inLink ? tryUrl(P, src, pos, mode, out) : 0;
    }
    if (n === 0) {
      const end = scanTextEnd(src, pos, len);
      const raw = src.slice(pos, end);
      if (P.inRawBlock) out.s += raw;
      else if (mode === 'text') out.s += decodeNumericRefs(raw);
      else out.s += escapeHtml(decodeNumericRefs(raw));
      if (src[end - 1] !== '_') prevChar = src[end - 1];
      keepPrevChar = true;
      n = end - pos;
    }
    pos += n;
  }
  return out.s;
}

// ----------------------------------------------------------- block parsing
//
// Block records (small plain objects, no token tree):
//   {t:'p', x} paragraph          {t:'x', x} bare text (list items)
//   {t:'h', d, x} heading         {t:'c', l, x} code (l = lang)
//   {t:'hr'}                      {t:'html', x} raw HTML block
//   {t:'bq', r, raw, text}        {t:'list', o, s, loose, items, raw}
//   {t:'table', h, a, rows}       table cells are {x} holders
// `x` is the block's inline source; P.queue holds every inline-run holder
// in lex order so task-checkbox fixups can find the last matching one.

function nextLineOf(src, pos) {
  const nl = src.indexOf('\n', pos);
  return nl === -1 ? src.slice(pos) : src.slice(pos, nl);
}

function indentCodeCompensation(raw, text) {
  const m = indentCodeCompensationRe.exec(raw);
  if (!m) return text;
  const indentToCode = m[1];
  return text.split('\n').map((node) => {
    const mn = beginningSpace.exec(node);
    if (!mn) return node;
    return node.slice(Math.min(mn[0].length, indentToCode.length));
  }).join('\n');
}

function parseBlockquote(P, src, start) {
  const cap = at(S_BLOCKQUOTE, src, start);
  if (!cap) return null;
  let lines = rtrim(cap[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];

  while (lines.length > 0) {
    let inBlockquote = false;
    const currentLines = [];
    let i;
    for (i = 0; i < lines.length; i++) {
      if (blockquoteStart.test(lines[i])) {
        currentLines.push(lines[i]);
        inBlockquote = true;
      } else if (!inBlockquote) {
        currentLines.push(lines[i]);
      } else {
        break;
      }
    }
    lines = lines.slice(i);

    const currentRaw = currentLines.join('\n');
    const currentText = currentRaw
      .replace(blockquoteMarkerWhitespace, (_, marker, whitespace) => marker + expandTabs(whitespace, marker.length))
      .replace(blockquoteSetextReplace, '\n    $1')
      .replace(blockquoteSetextReplace2, '');
    raw = raw ? raw + '\n' + currentRaw : currentRaw;
    text = text ? text + '\n' + currentText : currentText;

    const top = P.top;
    P.top = true;
    blockTokens(P, currentText, tokens, true);
    P.top = top;

    if (lines.length === 0) break;

    const lastToken = tokens[tokens.length - 1];
    if (lastToken && (lastToken.t === 'c' || lastToken.t === 'h' || lastToken.t === 'hr' || lastToken.t === 'html' || lastToken.t === 'table')) {
      break;
    } else if (lastToken && lastToken.t === 'bq') {
      const oldToken = lastToken;
      const continuation = lines.join('\n');
      const newText = oldToken.raw + '\n' + continuation.replace(blockquoteSetextReplace2, '');
      const parsed = parseBlockquote(P, newText, 0);
      if (!parsed) throw new Error('Infinite loop on byte: ' + newText.charCodeAt(0));
      const newToken = parsed.rec;
      tokens[tokens.length - 1] = newToken;

      const leftover = newText.substring(newToken.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (consumed.length > 0) raw = raw + '\n' + consumed.join('\n');
      text = text.substring(0, text.length - oldToken.text.length) + newToken.text;

      lines = lines.slice(consumed.length);
      if (lines.length > 0 && blockquoteStart.test(lines[0])) continue;
      break;
    } else if (lastToken && lastToken.t === 'list') {
      const oldToken = lastToken;
      const newText = oldToken.raw + '\n' + lines.join('\n');
      const parsed = parseList(P, newText, 0);
      if (!parsed) throw new Error('Infinite loop on byte: ' + newText.charCodeAt(0));
      const newToken = parsed.rec;
      tokens[tokens.length - 1] = newToken;

      const consumedCount = newToken.raw.length > oldToken.raw.length
        ? newText.slice(oldToken.raw.length + 1, newToken.raw.length).split('\n').length
        : 0;
      if (consumedCount > 0) {
        const consumed = lines.slice(0, consumedCount).join('\n');
        raw = raw + '\n' + consumed;
        text = text + '\n' + consumed;
      }
      lines = lines.slice(consumedCount);
      continue;
    }
    // Otherwise (paragraph/text): loop on; the next chunk's first paragraph
    // merges with this one via lastParagraphClipped.
  }

  return { rec: { t: 'bq', r: tokens, raw, text }, len: raw.length };
}

function parseList(P, src, start) {
  const cap0 = at(S_LIST, src, start);
  if (!cap0) return null;
  let cursor = start;
  let bull = cap0[1].trim();
  const isordered = bull.length > 1;

  const list = {
    t: 'list',
    o: isordered,
    s: isordered ? +bull.slice(0, -1) : '',
    loose: false,
    items: [],
    raw: '',
  };

  bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
  const itemRegex = listItemRegex(bull);
  let endsWithBlankLine = false;

  while (cursor < src.length) {
    let endEarly = false;
    let itemContents = '';
    const cap = at(itemRegex, src, cursor);
    if (!cap) break;
    if (at(S_HR, src, cursor)) break;

    const itemStart = cursor;
    cursor += cap[0].length;

    const firstLine = cap[2].split('\n', 1)[0];
    const bulletIndent = cap[1].length;
    let line = hasLeadingTab(firstLine)
      ? firstLine.replace(leadingSpaceTab, (ws) => expandTabs(ws, bulletIndent))
      : firstLine;
    const nextLine = nextLineOf(src, cursor);
    let blankLine = !line.trim();

    let indent = 0;
    if (blankLine) {
      indent = bulletIndent + 1;
    } else {
      indent = line.search(nonSpaceChar);
      indent = indent > 4 ? 1 : indent;
      itemContents = line.slice(indent);
      indent += bulletIndent;
    }

    if (blankLine && blankLineRe.test(nextLine)) {
      cursor += nextLine.length + 1;
      if (cursor > src.length) cursor = src.length;
      endEarly = true;
    }

    if (!endEarly) {
      const bi = clampIndent(indent);
      const nextBulletRe = nextBulletRes[bi];
      const hrLineRe = hrLineRes[bi];
      const fencesBeginRe = fencesBeginRes[bi];
      const headingBeginRe = headingBeginRes[bi];
      const htmlBeginRe = htmlBeginRes[bi];
      const blockquoteBeginRe = blockquoteBeginRes[bi];

      while (cursor < src.length) {
        const rawLine = nextLineOf(src, cursor);
        const nextLn = rawLine;
        const nextLineWithoutTabs = hasLeadingTab(nextLn)
          ? nextLn.replace(leadingSpaceTab, (ws) => expandTabs(ws))
          : nextLn;

        if (fencesBeginRe.test(nextLn)) break;
        if (headingBeginRe.test(nextLn)) break;
        if (htmlBeginRe.test(nextLn)) break;
        if (blockquoteBeginRe.test(nextLn)) break;
        if (nextBulletRe.test(nextLn)) break;
        if (hrLineRe.test(nextLn)) break;

        if (nextLineWithoutTabs.search(nonSpaceChar) >= indent || !nextLn.trim()) {
          itemContents += '\n' + nextLineWithoutTabs.slice(indent);
        } else {
          if (blankLine) break;
          if ((line.includes('\t') ? line.replace(tabCharGlobal, '    ') : line).search(nonSpaceChar) >= 4) break;
          if (fencesBeginRe.test(line)) break;
          if (headingBeginRe.test(line)) break;
          if (htmlBeginRe.test(line)) break;
          if (hrLineRe.test(line)) break;

          const setextContinuation = setextLine.test(nextLn)
            && lheadingRe.test(line + '\n' + nextLn);
          const continuation = setextContinuation
            ? '    ' + nextLineWithoutTabs.replace(leading3Spaces, '')
            : nextLn;
          itemContents += '\n' + continuation;
        }

        blankLine = !nextLn.trim();
        cursor += rawLine.length + 1;
        if (cursor > src.length) cursor = src.length;
        line = nextLineWithoutTabs.slice(indent);
      }
    }

    const raw = src.slice(itemStart, cursor);

    if (!list.loose) {
      if (endsWithBlankLine) list.loose = true;
      else if (doubleBlankLine.test(raw)) endsWithBlankLine = true;
    }

    list.items.push({
      raw,
      task: listIsTask.test(itemContents),
      text: itemContents,
      r: [],
      check: null,
    });
  }

  const lastItem = list.items[list.items.length - 1];
  if (!lastItem) return null;
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  list.raw = src.slice(start, cursor).trimEnd();

  for (const item of list.items) {
    P.top = false;
    const sawDoubleBlank = blockTokens(P, item.text, item.r, false);
    if (!list.loose) list.loose = sawDoubleBlank;
  }

  for (const item of list.items) {
    const itemToken = item.r[0];
    if (item.task && itemToken && (itemToken.t === 'x' || itemToken.t === 'p')) {
      // Remove the checkbox from the last task-looking inline run queued so
      // far (usually this item's first paragraph, but a later item's run or
      // a second paragraph in this item can win the search, as in marked).
      for (let i = P.queue.length - 1; i >= 0; i--) {
        if (listIsTask.test(P.queue[i].x)) {
          P.queue[i].x = P.queue[i].x.replace(listReplaceTask, '');
          break;
        }
      }
      const taskRaw = listTaskCheckbox.exec(item.raw);
      if (taskRaw) item.check = taskRaw[0] !== '[ ]';
    } else if (item.task) {
      item.task = false;
    }
  }

  if (list.loose) {
    for (const item of list.items) {
      for (const tok of item.r) {
        if (tok.t === 'x') tok.t = 'p';
      }
    }
  }

  return { rec: list, len: list.raw.length };
}

// The block loop: tries the block rules in marked's order at each position,
// scanning by index (no slicing of the remainder). Returns true when a
// blank run of two or more newlines was seen at this level (list looseness).
// Does src[start..end] (one line, no trailing newline) match the table
// delimiter pattern ` {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)`
// and contain a `:` or `|` (marked's tableDelimiter guard, which keeps a
// bare `---` row a setext underline instead of a table)?
function isDelimiterRow(src, start, end) {
  let i = start;
  let sp = 0;
  while (i < end && src[i] === ' ' && sp < 3) { i++; sp++; }
  if (i < end && src[i] === ' ') return false;
  let marked = false;
  if (i < end && src[i] === '|') { marked = true; i++; while (i < end && src[i] === ' ') i++; }
  let cells = 0;
  for (;;) {
    if (i < end && src[i] === ':') { marked = true; i++; }
    let dashes = 0;
    while (i < end && src[i] === '-') { i++; dashes++; }
    if (dashes === 0) return false;
    if (i < end && src[i] === ':') { marked = true; i++; }
    while (i < end && src[i] === ' ') i++;
    cells++;
    if (i >= end) return cells > 0 && marked;
    if (src[i] !== '|') return false;
    marked = true;
    i++;
    while (i < end && src[i] === ' ') i++;
    if (i >= end) return cells > 0 && marked;
  }
}

// Setext underline: ` {0,3}(=+|-+)[ \t]*$`.
function isSetextLine(src, start, end) {
  let i = start;
  let sp = 0;
  while (i < end && src[i] === ' ' && sp < 3) { i++; sp++; }
  if (i < end && src[i] === ' ') return false;
  const c = src[i];
  if (c !== '=' && c !== '-') return false;
  while (i < end && src[i] === c) i++;
  while (i < end && (src[i] === ' ' || src[i] === '\t')) i++;
  return i >= end;
}

// The lheading lookahead's `table` alternative: a line of only `|`, `:`,
// `-`, ` ` with at least one `|` (after 0-3 spaces).
function isTableDelimiterLine(src, start, end) {
  let i = start;
  let sp = 0;
  while (i < end && src[i] === ' ' && sp < 3) { i++; sp++; }
  if (i < end && src[i] === ' ') return false;
  let pipes = 0;
  while (i < end) {
    const c = src[i];
    if (c === '|') pipes++;
    else if (c !== ':' && c !== '-' && c !== ' ') return false;
    i++;
  }
  return pipes >= 1;
}

// Can the lheading rule match at `pos`? Cheap pre-check for the expensive
// lheading regex: the first line must pass its lookahead (fences, html and
// table-delimiter first lines block it; bullet/code/blockquote/heading first
// lines are already excluded because those rules run earlier), and a setext
// underline line must be reachable before the next blank line.
function lheadingPossible(src, pos, len) {
  let i = pos;
  let sp = 0;
  while (sp < 3 && src[i] === ' ') { i++; sp++; }
  const c = src[i];
  if (c === '`' || c === '~') {
    let j = i;
    while (src[j] === c) j++;
    if (j - i >= 3) return false;
  }
  if (c === '<') {
    const gt = src.indexOf('>', i + 1);
    if (gt > i + 1) {
      const nl = src.indexOf('\n', i);
      if ((nl === -1 || gt < nl) && src[gt + 1] === '\n') return false;
    }
  }
  let firstEnd = src.indexOf('\n', pos);
  if (firstEnd === -1) firstEnd = len;
  if (firstEnd < len && isTableDelimiterLine(src, pos, firstEnd)) return false;
  let lineStart = firstEnd + 1;
  while (lineStart < len) {
    let lineEnd = src.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = len;
    let j = lineStart;
    while (j < lineEnd && (src[j] === ' ' || src[j] === '\t')) j++;
    if (j >= lineEnd) return false;
    if (isSetextLine(src, lineStart, lineEnd)) return true;
    lineStart = lineEnd + 1;
  }
  return false;
}

function blockTokens(P, src, out, lastParagraphClipped = false) {
  const len = src.length;
  let pos = 0;
  let sawDoubleBlank = false;
  // Type of the last token in `out`, including 'space' and 'def' tokens,
  // which render nothing but break paragraph/text/code merging. Kept on the
  // array so blockquote continuation chunks share it, as marked shares the
  // token list across chunks.
  let lastType = out.lt || '';

  while (pos < len) {
    const ch = src[pos];
    let cap;

    // Lines starting with whitespace: blank line, indented code, or a
    // 0-3-space indent in front of some other block.
    let first = pos;
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      let i = pos;
      let spaces = 0;
      let tabAt = -1;
      while (i < len) {
        const c = src[i];
        if (c === ' ') { spaces++; i++; }
        else if (c === '\t') { if (tabAt === -1) tabAt = i; i++; }
        else break;
      }
      const c2 = src[i];
      if (c2 === undefined || c2 === '\n') {
        // Blank line(s): the newline rule always matches here.
        cap = at(S_NEWLINE, src, pos);
        const raw = cap[0];
        const firstNl = raw.indexOf('\n');
        if (firstNl !== -1 && raw.indexOf('\n', firstNl + 1) !== -1) sawDoubleBlank = true;
        // A lone newline folds into the previous token; anything else is a
        // spacer token of its own and breaks merging.
        if (!(raw.length === 1 && lastType !== '')) lastType = 'space';
        pos += raw.length;
        continue;
      }
      if (tabAt !== -1 || spaces >= 4) {
        // Indented code: any leading tab, or 4+ leading spaces.
        cap = at(S_CODE, src, pos);
        const raw = trimTrailingBlankLines(cap[0]);
        const text = raw.replace(codeRemoveIndent, '');
        const last = out[out.length - 1];
        if ((lastType === 'p' || lastType === 'x') && last) {
          last.x += '\n' + text;
        } else {
          out.push({ t: 'c', l: '', x: text });
          lastType = 'c';
        }
        pos += raw.length;
        continue;
      }
      first = i;
    }

    // Dispatch on the first non-space character: most block rules can only
    // start with a specific character, so the rest need not even be tried.
    const m = src[first];
    if (m === '`' || m === '~') {
      cap = at(S_FENCES, src, pos);
      if (cap) {
        const text = indentCodeCompensation(cap[0], cap[3] || '');
        const lang = cap[2] ? cap[2].trim().replace(anyPunctuationRe, '$1') : cap[2];
        out.push({ t: 'c', l: lang, x: text });
        lastType = 'c';
        pos += cap[0].length;
        continue;
      }
    } else if (m === '#') {
      cap = at(S_HEADING, src, pos);
      if (cap) {
        let text = cap[2].trim();
        if (endingHash.test(text)) {
          const trimmed = rtrim(text, '#');
          if (!trimmed || endingSpaceTabChar.test(trimmed)) text = trimmed.trim();
        }
        const rec = { t: 'h', d: cap[1].length, x: text };
        out.push(rec);
        P.queue.push(rec);
        lastType = 'h';
        pos += rtrim(cap[0], '\n').length;
        continue;
      }
    } else if (m === '-' || m === '*') {
      cap = at(S_HR, src, pos);
      if (cap) {
        out.push({ t: 'hr' });
        lastType = 'hr';
        pos += rtrim(cap[0], '\n').length;
        continue;
      }
      const lst = parseList(P, src, pos);
      if (lst) {
        out.push(lst.rec);
        lastType = 'list';
        pos += lst.len;
        continue;
      }
    } else if (m === '+' || (m >= '0' && m <= '9')) {
      const lst = parseList(P, src, pos);
      if (lst) {
        out.push(lst.rec);
        lastType = 'list';
        pos += lst.len;
        continue;
      }
    } else if (m === '_') {
      cap = at(S_HR, src, pos);
      if (cap) {
        out.push({ t: 'hr' });
        lastType = 'hr';
        pos += rtrim(cap[0], '\n').length;
        continue;
      }
    } else if (m === '>') {
      const bq = parseBlockquote(P, src, pos);
      if (bq) {
        out.push(bq.rec);
        lastType = 'bq';
        pos += bq.len;
        continue;
      }
    } else if (m === '<') {
      cap = at(S_HTML, src, pos);
      if (cap) {
        const raw = trimTrailingBlankLines(cap[0]);
        out.push({ t: 'html', x: raw });
        lastType = 'html';
        pos += raw.length;
        continue;
      }
    } else if (m === '[') {
      cap = at(S_DEF, src, pos);
      if (cap && (startAngleBracket.test(cap[2]) || findClosingBracket(cap[2], '()') === -1)) {
        const tag = normalizeLabel(cap[1]);
        const href = cap[2] ? cap[2].replace(hrefBrackets, '$1').replace(anyPunctuationRe, '$1') : '';
        const title = cap[3]
          ? cap[3].substring(1, cap[3].length - 1).replace(anyPunctuationRe, '$1')
          : cap[3];
        const rawLen = rtrim(cap[0], '\n').length;
        const raw = cap[0].slice(0, rawLen);
        const last = out[out.length - 1];
        if ((lastType === 'p' || lastType === 'x') && last) {
          last.x += '\n' + raw;
        } else {
          if (!P.links[tag]) P.links[tag] = { href, title };
          lastType = 'def';
        }
        pos += rawLen;
        continue;
      }
    }

    // Table: only when the next line is a delimiter row.
    const nl = src.indexOf('\n', pos);
    if (nl !== -1) {
      const nextStart = nl + 1;
      let nextEnd = src.indexOf('\n', nextStart);
      if (nextEnd === -1) nextEnd = len;
      if (isDelimiterRow(src, nextStart, nextEnd)) {
        cap = at(S_TABLE, src, pos);
        if (cap && tableDelimiter.test(cap[2])) {
          const headers = splitCells(cap[1]);
          const aligns = cap[2].replace(tableAlignChars, '').split('|');
          if (headers.length === aligns.length) {
            const rows = cap[3]?.trim() ? cap[3].replace(tableRowBlankLine, '').split('\n') : [];
            const align = [];
            for (const a of aligns) {
              if (tableAlignRight.test(a)) align.push('right');
              else if (tableAlignCenter.test(a)) align.push('center');
              else if (tableAlignLeft.test(a)) align.push('left');
              else align.push(null);
            }
            const header = headers.map((h) => ({ x: h }));
            const rowCells = rows.map((row) => splitCells(row, headers.length).map((c) => ({ x: c })));
            out.push({ t: 'table', h: header, a: align, rows: rowCells });
            for (const c of header) P.queue.push(c);
            for (const row of rowCells) for (const c of row) P.queue.push(c);
            lastType = 'table';
            pos += rtrim(cap[0], '\n').length;
            continue;
          }
        }
      }
    }

    // Setext heading: only when an underline line is reachable.
    if (lheadingPossible(src, pos, len)) {
      cap = at(S_LHEADING, src, pos);
      if (cap) {
        const rec = { t: 'h', d: cap[2].charAt(0) === '=' ? 1 : 2, x: cap[1].trim() };
        out.push(rec);
        P.queue.push(rec);
        lastType = 'h';
        pos += rtrim(cap[0], '\n').length;
        continue;
      }
    }

    if (P.top) {
      cap = at(S_PARAGRAPH, src, pos);
      if (cap) {
        let text = cap[1];
        if (text.charAt(text.length - 1) === '\n') text = text.slice(0, -1);
        const last = out[out.length - 1];
        if (lastParagraphClipped && lastType === 'p' && last) {
          last.x += '\n' + text;
        } else {
          const rec = { t: 'p', x: text };
          out.push(rec);
          P.queue.push(rec);
          lastType = 'p';
        }
        lastParagraphClipped = false;
        pos += cap[0].length;
        continue;
      }
    }

    cap = at(S_TEXT, src, pos);
    if (cap) {
      const last = out[out.length - 1];
      if (lastType === 'x' && last) {
        last.x += '\n' + cap[0];
      } else {
        const rec = { t: 'x', x: cap[0] };
        out.push(rec);
        P.queue.push(rec);
        lastType = 'x';
      }
      pos += cap[0].length;
      continue;
    }

    throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
  }

  P.top = true;
  out.lt = lastType;
  return sawDoubleBlank;
}

// --------------------------------------------------------------- rendering

function renderBlocks(P, records, out, start = 0) {
  for (let i = start; i < records.length; i++) {
    const rec = records[i];
    switch (rec.t) {
      case 'p':
        out.s += '<p>' + inlineTop(P, rec.x) + '</p>\n';
        break;
      case 'x':
        out.s += inlineTop(P, rec.x);
        break;
      case 'h':
        out.s += '<h' + String(rec.d) + '>' + inlineTop(P, rec.x) + '</h' + String(rec.d) + '>\n';
        break;
      case 'c': {
        const langString = (rec.l || '').match(notSpaceStart)?.[0];
        const code = rec.x ? rec.x.replace(endingNewline, '') + '\n' : '';
        const esc = escapeHtml(code, true);
        if (!langString) out.s += '<pre><code>' + esc + '</code></pre>\n';
        else out.s += '<pre><code class="language-' + escapeHtml(langString) + '">' + esc + '</code></pre>\n';
        break;
      }
      case 'hr':
        out.s += '<hr>\n';
        break;
      case 'html':
        out.s += rec.x;
        break;
      case 'bq':
        out.s += '<blockquote>\n';
        renderBlocks(P, rec.r, out);
        out.s += '</blockquote>\n';
        break;
      case 'list': {
        const type = rec.o ? 'ol' : 'ul';
        const startAttr = (rec.o && rec.s !== 1) ? ' start="' + rec.s + '"' : '';
        out.s += '<' + type + startAttr + '>\n';
        for (const item of rec.items) {
          out.s += '<li>';
          renderListItem(P, rec, item, out);
          out.s += '</li>\n';
        }
        out.s += '</' + type + '>\n';
        break;
      }
      case 'table': {
        out.s += '<table>\n<thead>\n<tr>\n';
        for (let j = 0; j < rec.h.length; j++) {
          const align = rec.a[j];
          out.s += (align ? '<th align="' + align + '">' : '<th>') + inlineTop(P, rec.h[j].x) + '</th>\n';
        }
        out.s += '</tr>\n</thead>\n';
        if (rec.rows.length > 0) {
          out.s += '<tbody>';
          for (const row of rec.rows) {
            out.s += '<tr>\n';
            for (let k = 0; k < row.length; k++) {
              const align = rec.a[k];
              out.s += (align ? '<td align="' + align + '">' : '<td>') + inlineTop(P, row[k].x) + '</td>\n';
            }
            out.s += '</tr>\n';
          }
          out.s += '</tbody>';
        }
        out.s += '</table>\n';
        break;
      }
    }
  }
}

function renderListItem(P, list, item, out) {
  if (item.check === null) {
    renderBlocks(P, item.r, out);
    return;
  }
  const box = '<input ' + (item.check ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
  if (list.loose) {
    const first = item.r[0];
    if (first && (first.t === 'p' || first.t === 'x')) {
      out.s += '<p>' + box + inlineTop(P, first.x) + '</p>\n';
      renderBlocks(P, item.r, out, 1);
      return;
    }
    out.s += '<p>' + box + '</p>\n';
    renderBlocks(P, item.r, out);
    return;
  }
  out.s += box;
  renderBlocks(P, item.r, out);
}

// ------------------------------------------------------------------- entry

/** The HTML marked 18.1.3 renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  const src = markdown.replace(carriageReturn, '\n');
  const P = {
    links: Object.create(null),
    top: true,
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
    queue: [],
  };
  const records = [];
  blockTokens(P, src, records, false);
  const out = { s: '' };
  renderBlocks(P, records, out);
  return out.s;
}
