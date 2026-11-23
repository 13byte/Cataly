const INPUT_RULE = /^─{10,}$/;
/** Lines omo prints below its input box (cwd/model line, status line); more than this and the box is not at the bottom. */
const FOOTER_MAX_LINES = 3;

/**
 * True only when an omo screen positively shows its idle input at the bottom: a bare rule, an empty `❯`
 * line, a bare rule, and no `esc to interrupt` anywhere. Anything else (a turn, a dialog, a draft in the
 * input, an unknown layout) is false, so the caller keeps queueing (#62: an omo whose live monitors or background
 * cells are running can look busy between turns).
 */
export function omoScreenIdle(screen: string): boolean {
  if (screen.includes("esc to interrupt")) return false;
  const lines = screen.split("\n").map((l) => l.trimEnd());
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  const input = lines.lastIndexOf("❯");
  if (input < 1 || input + 1 >= lines.length) return false;
  if (!INPUT_RULE.test(lines[input - 1] ?? "") || !INPUT_RULE.test(lines[input + 1] ?? "")) return false;
  return lines.length - 1 - (input + 1) <= FOOTER_MAX_LINES;
}

/**
 * A terminal that prints screen rows with trailing blanks cut and says nothing about wrapping: a row that fills the
 * terminal is taken as wrapped, `cols` cells wide (cut inside a word: joined as is), or `cols - 1` when the wrap fell on
 * a space that was cut (joined with that space put back, so `rate` + `limit` reads `rate limit` again). Width is counted
 * in terminal cells (a CJK character or an emoji is two). A line the agent printed exactly that wide is joined to the
 * next one too: callers must not treat a joined line as one message (launch strips only the warning text, never a line).
 */
export const joinWrapped = (text: string, cols: number): string => {
  const lines: string[] = [];
  let glue: string | undefined;
  for (const row of text.split("\n")) {
    if (glue === undefined) lines.push(row);
    else lines[lines.length - 1] += glue + row;
    const width = Bun.stringWidth(row);
    glue = cols <= 1 || width < cols - 1 ? undefined : width >= cols ? "" : " ";
  }
  return lines.join("\n");
};
