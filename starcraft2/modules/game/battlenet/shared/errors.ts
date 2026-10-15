export class BattleNetVfsError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'BattleNetVfsError'
  }
}
