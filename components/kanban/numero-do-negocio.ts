export function numeroDoNegocio(id: string): string {
  return `#${id.slice(0, 6).toUpperCase()}`;
}
