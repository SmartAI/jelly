/** RE2-compatible complement of finite approved URL prefixes, split into small
 * block-only rules, avoiding priority interactions with allow exemptions.
 * Splitting avoids Chrome's 2 KiB compiled-regex limit. Callers must explicitly
 * include main_frame: Chrome's default resourceTypes excludes it.
 */
export function chromeDenyRegexes(origins: string[]): string[] {
  interface Trie {
    terminal: boolean;
    children: Map<string, Trie>;
  }
  const root: Trie = { terminal: false, children: new Map() };
  for (const origin of origins) {
    let node = root;
    for (const char of `${origin}/`) {
      if (!node.children.has(char))
        node.children.set(char, { terminal: false, children: new Map() });
      node = node.children.get(char)!;
    }
    node.terminal = true;
  }
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  const result: string[] = [];
  function visit(node: Trie, prefix: string) {
    if (node.terminal) return;
    const keys = [...node.children.keys()];
    result.push(`^${escape(prefix)}(?:$|[^${keys.map(escape).join("")}])`);
    for (const [char, next] of node.children) visit(next, prefix + char);
  }
  if (!origins.length) return [".*"];
  visit(root, "");
  return result;
}
