export function isLoopback(hostname: string) {
  return hostname === "localhost" || hostname === "[::1]" || /^127\./.test(hostname);
}
