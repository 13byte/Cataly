// The simple commands of a shell (or `env -S`) script string, as argv words: quotes and backslashes removed, comments
// dropped, and a new command after `;`, `&`, `|`, `(`, `)`, a backtick, `$(` or a newline. Leading control keywords
// (`if`, `do`, `!` …) and `exec`/`command`/`builtin` are removed, so each list starts at the program that runs.
// Expansions are not evaluated: `"$HOME/bin/omp"` stays that word, which still ends in the program's name.
const KEYWORDS = new Set([
  "if",
  "then",
  "elif",
  "else",
  "while",
  "until",
  "do",
  "!",
  "{",
  "time",
  "command",
  "builtin",
]);

export function scriptCommands(script: string): string[][] {
  const commands: string[][] = [[]];
  let word = "";
  let started = false;
  let quote = "";
  const end = () => {
    if (started) commands.at(-1)!.push(word);
    word = "";
    started = false;
  };
  for (let i = 0; i < script.length; i++) {
    const c = script[i]!;
    if (quote) {
      if (c === quote) quote = "";
      else if (c === "\\" && quote === '"' && i + 1 < script.length) word += script[++i];
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (c === "\\" && i + 1 < script.length) {
      word += script[++i];
      started = true;
    } else if (c === "#" && !started) {
      while (i + 1 < script.length && script[i + 1] !== "\n") i++;
    } else if (/\s/.test(c) && c !== "\n") {
      end();
    } else if (";&|()`\n".includes(c) || (c === "$" && script[i + 1] === "(")) {
      end();
      if (c === "$") i++;
      commands.push([]);
    } else {
      word += c;
      started = true;
    }
  }
  end();
  return commands.map(program).filter((command) => command.length > 0);
}

/** A simple command from its program on: control keywords and `exec [-cl] [-a NAME]` removed. */
function program(command: string[]): string[] {
  let at = 0;
  for (;;) {
    if (KEYWORDS.has(command[at] ?? "")) at++;
    else if (command[at] === "exec") {
      at++;
      while (command[at]?.startsWith("-")) at += command[at] === "-a" ? 2 : 1;
    } else return command.slice(at);
  }
}
