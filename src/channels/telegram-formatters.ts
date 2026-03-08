/**
 * Converts markdown-formatted text to Telegram HTML subset.
 * Fenced code blocks and inline code are extracted as placeholders first
 * so their content is never processed by bold/italic regexes.
 */
export function markdownToTelegramHtml(text: string): string {
  const codeBlocks: string[] = [];
  const inlineCode: string[] = [];

  // Step 1a: extract fenced code blocks
  let result = text.replace(/```(?:[^\n`]*)?\n([\s\S]*?)```/g, (_m, code: string) => {
    const esc = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    return `\x00CB${codeBlocks.push(`<pre><code>${esc}</code></pre>`) - 1}\x00`;
  });

  // Step 1b: extract inline code spans
  result = result.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    const esc = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    return `\x00IC${inlineCode.push(`<code>${esc}</code>`) - 1}\x00`;
  });

  // Step 2: HTML-escape remaining plain text
  result = result.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Step 3: markdown → HTML (bold before italic to avoid ** partial match)
  result = result.replace(/\*\*(.+?)\*\*/gs, '<b>$1</b>');
  result = result.replace(/~~(.+?)~~/gs, '<s>$1</s>');
  result = result.replace(/\*([^*\n]+)\*/g, '<i>$1</i>');
  result = result.replace(/_([^_\n]+)_/g, '<i>$1</i>');
  result = result.replace(/^#{1,6} +(.+)$/gm, '<b>$1</b>');
  result = result.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>');

  // Step 4 & 5: restore placeholders
  result = result.replace(/\x00IC(\d+)\x00/g, (_m, i) => inlineCode[Number(i)]);
  result = result.replace(/\x00CB(\d+)\x00/g, (_m, i) => codeBlocks[Number(i)]);

  return result;
}

/**
 * Splits a string into chunks of at most maxLen chars.
 * Prefers double-newline paragraph splits, then single-newline, then hard-split.
 */
export function chunkHtml(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];

  function splitLines(segment: string): void {
    const lines = segment.split('\n');
    let cur = '';

    for (const line of lines) {
      const cand = cur ? cur + '\n' + line : line;

      if (cand.length <= maxLen) {
        cur = cand;
        continue;
      }

      if (cur) chunks.push(cur);

      if (line.length > maxLen) {
        for (let i = 0; i < line.length; i += maxLen) chunks.push(line.slice(i, i + maxLen));
        cur = '';
      } else {
        cur = line;
      }
    }

    if (cur) chunks.push(cur);
  }

  const paras = text.split('\n\n');
  let cur = '';

  for (const para of paras) {
    const cand = cur ? cur + '\n\n' + para : para;

    if (cand.length <= maxLen) {
      cur = cand;
      continue;
    }

    if (cur) chunks.push(cur);

    cur = '';

    if (para.length > maxLen) splitLines(para);
    else cur = para;
  }

  if (cur) chunks.push(cur);

  return chunks;
}
