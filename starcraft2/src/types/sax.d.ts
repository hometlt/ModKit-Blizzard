declare module 'sax' {
  interface SaxTag {
    readonly name: string
    readonly attributes: Record<string, string>
  }

  interface SaxParser {
    onopentag: ((node: SaxTag) => void) | undefined
    onclosetag: ((name: string) => void) | undefined
    ontext: ((text: string) => void) | undefined
    oncdata: ((text: string) => void) | undefined
    write(text: string): SaxParser
    close(): SaxParser
  }

  interface SaxModule {
    parser(strict: boolean, options?: Readonly<Record<string, unknown>>): SaxParser
  }

  const sax: SaxModule
  export default sax
}
