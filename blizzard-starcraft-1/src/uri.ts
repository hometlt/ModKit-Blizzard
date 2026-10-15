/** The file name a URI ends in, lower-case; a container entry's path may come percent-encoded. */
export function fileNameOf(uri: string): string {
  const path = decodeURIComponent(uri.split(/[?#]/u, 1)[0]!).replaceAll('\\', '/')
  return path.slice(path.lastIndexOf('/') + 1).toLowerCase()
}
