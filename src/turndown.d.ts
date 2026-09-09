declare module 'turndown' {
  class TurndownService {
    static defaultOptions: Record<string, unknown>
    constructor(options?: Record<string, unknown>)
    remove(filter: string | string[]): TurndownService
    turndown(html: string): string
  }
  export = TurndownService
}
