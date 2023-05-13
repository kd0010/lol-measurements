import { Region } from 'lol-constants'

export class MinuteAnalyzer {
  gameIds: number[]
  region: Region
  constructor({
    gameIds,
    region,
  }: {
    gameIds: number[]
    region: Region
  }) {
    this.gameIds = gameIds
    this.region = region
  }

  analyze() {
  }

  async #fetchGames(
    gameIds: string[],
    region: Region,
  ) {
  }
}
