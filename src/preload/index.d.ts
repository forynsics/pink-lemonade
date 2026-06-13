export interface Api {
  openFile: () => Promise<{ name: string; content: string } | null>
  saveFile: (content: string) => Promise<string | null>
}

declare global {
  interface Window {
    api: Api
  }
}
