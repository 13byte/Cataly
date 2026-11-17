// The shell syntax a watch's command string is read with (monitor-command.ts): its words, what each passes on, the
// command substitutions inside double quotes, and `env -S`'s own splitting.

/** One word of a command string: its text with quotes, where it is, and whether a new command starts at it. */
export type ShellWord = { readonly text: string; readonly from: number; readonly to: number; readonly starts: boolean };

// Outside quotes these end a word and start a new command; the longer one first.
const OPERATORS = ["&&", "||", "$(", ";", "|", "&", "(", ")", "`"];

/**
 * The words of `line`: split at whitespace and operators outside quotes, with or without spaces around them
 * (`true&&dori`, `a;b`); a line break starts a new command too. A quoted or backslash-escaped part stays in its word
 * (`rg -F \;`), and a backslash before a line break continues the line.
 */
export const shellWords = (line: string): ShellWord[] => {
  const words: ShellWord[] = [];
  let start = -1;
  let starts = true;
  let quote: string | undefined;
  const end = (at: number): void => {
    if (start >= 0) words.push({ text: line.slice(start, at), from: start, to: at, starts });
    if (start >= 0) starts = false;
    start = -1;
  };
  for (let at = 0; at < line.length; at++) {
    const char = line[at] ?? "";
    if (quote === "'") {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "\\") {
      if (start < 0 && line[at + 1] === "\n") at++;
      else {
        if (start < 0) start = at;
        at++;
      }
      continue;
    }
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      continue;
    }
    const operator = OPERATORS.find((op) => line.startsWith(op, at));
    if (/\s/.test(char) || operator !== undefined) {
      end(at);
      if (char === "\n" || operator !== undefined) starts = true;
      at += (operator?.length ?? 1) - 1;
      continue;
    }
    if (start < 0) start = at;
    if (char === "'" || char === '"') quote = char;
  }
  end(line.length);
  return words;
};

/**
 * A word as the shell passes it on: quotes removed, escapes resolved (only `\"`, `\\`, `\$`, `` \` `` inside double
 * quotes), line continuations dropped; `at` maps each character back to its index in the word.
 */
export const unquote = (word: string): { readonly text: string; readonly at: readonly number[] } => {
  let text = "";
  const at: number[] = [];
  let quote: string | undefined;
  for (let i = 0; i < word.length; i++) {
    const char = word[i] ?? "";
    const next = word[i + 1] ?? "";
    if (quote !== "'" && char === "\\" && next === "\n") i++;
    else if (quote !== "'" && char === "\\" && next && (quote === undefined || '"\\$`'.includes(next))) {
      text += next;
      at.push(++i);
    } else if (char === quote || (quote === undefined && (char === "'" || char === '"')))
      quote = quote === undefined ? char : undefined;
    else {
      text += char;
      at.push(i);
    }
  }
  return { text, at };
};

/** The `$(...)` and backtick command substitutions inside a word's double quotes: where each one's command is. */
export const quotedSubstitutions = (word: string): { readonly from: number; readonly to: number }[] => {
  const found: { from: number; to: number }[] = [];
  let quote: string | undefined;
  for (let at = 0; at < word.length; at++) {
    const char = word[at] ?? "";
    if (quote === "'") {
      if (char === quote) quote = undefined;
    } else if (char === "\\") at++;
    else if (quote === '"' && (char === "`" || word.startsWith("$(", at))) {
      const from = at + (char === "`" ? 1 : 2);
      let to = from;
      if (char === "`") while (to < word.length && word[to] !== "`") to += word[to] === "\\" ? 2 : 1;
      else
        for (let depth = 1; to < word.length; to++) {
          if (word[to] === "(") depth++;
          else if (word[to] === ")" && --depth === 0) break;
        }
      found.push({ from, to: Math.min(to, word.length) });
      at = to;
    } else if (char === quote) quote = undefined;
    else if (quote === undefined && (char === "'" || char === '"')) quote = char;
  }
  return found;
};

/**
 * `env -S STRING`'s words: split at whitespace outside quotes, quotes removed, a backslash escaping the next character
 * (`\_` is a space); `at` maps each character back to its index in STRING.
 */
export const splitString = (line: string): { readonly text: string; readonly at: readonly number[] }[] => {
  const words: { text: string; at: number[] }[] = [];
  let word: { text: string; at: number[] } | undefined;
  let quote: string | undefined;
  const add = (char: string, at: number): void => {
    word ??= { text: "", at: [] };
    word.text += char;
    word.at.push(at);
  };
  for (let at = 0; at < line.length; at++) {
    const char = line[at] ?? "";
    if (quote === "'" && char !== "'") add(char, at);
    else if (char === "\\" && quote !== "'" && at + 1 < line.length) {
      const next = line[++at] ?? "";
      add(next === "_" ? " " : next, at);
    } else if (char === quote) quote = undefined;
    else if (quote === undefined && (char === "'" || char === '"')) {
      quote = char;
      word ??= { text: "", at: [] };
    } else if (quote === undefined && /\s/.test(char)) {
      if (word) words.push(word);
      word = undefined;
    } else add(char, at);
  }
  if (word) words.push(word);
  return words;
};
