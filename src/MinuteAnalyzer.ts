import { Region, TeamId } from 'lol-constants'
import { Cache } from '../../lol-personal-db'
import { max, mean, min } from 'rift-js-utils/number'
import { doBatches } from 'rift-js-utils/functions'

export class MinuteAnalyzer {
  gameIds: number[]
  puuids: string[] | null
  region: Region
  constructor({
    gameIds,
    puuids,
    region,
  }: {
    gameIds: number[]
    /** PUUIDs to include in analysis. */
    puuids?: string[]
    region: Region
  }) {
    this.gameIds = gameIds
    this.puuids = puuids ?? null
    this.region = region
  }

  async analyze() {
    let combination = this.#combinePlayerMinuteAnalysis(null, [])
    await doBatches(this.gameIds, async gameId => {
      const analysis = await this.analyzeGame(
        gameId,
        this.puuids ?? undefined,
      )

      this.#combinePlayerMinuteAnalysis(
        combination,
        [analysis],
      )
    }, {
      batchSize: 15,
      betweenBatchesWaitTime: 1000,
      limit: {
        duration: 120_000,
        itemAmount: 90,
      },
    })

    console.log('SAMPLE_SIZE', combination[this.puuids![0]!]![180]!.sampleSize) // TEMP
    
    const mean = this.#getPlayerMinuteAnalysisAggregate(combination)

    return mean
  }
  
  async analyzeGame(
    gameId: number,
    /** PUUIDs to include in the end result. */
    puuids?: string[],
  ): Promise<PlayerMinuteAnalysis> {
    const timeline = await Cache.getMatchTimeline(gameId)

    const players: PlayerMinuteAnalysis = {}

    for (const {
      participantId,
      puuid,
    } of timeline.data.participants) {
      if (puuids != null && !puuids.includes(puuid)) continue

      const teamId: TeamId = [1, 2, 3, 4, 5].includes(participantId) ? 100 : 200
      let previousFrameDamageDealtToChampions = 0
      let previousFrameDamageTaken = 0
      let previousFrameCreepsKilled = 0
      let previousFrameTotalGold = 0
      let previousFrameTotalXp = 0

      const framesWithoutLastFrame = timeline.data.frames.slice(0, -1)
      for (const frame of framesWithoutLastFrame) {
        let timestampEnd = Math.floor(frame.timestamp / 1000)
        let timestampBegin = Math.max(0, timestampEnd - 60)
        const minuteAnalysis: MinuteAnalysis = this.#createMinuteAnalysis(
          timestampBegin,
          timestampEnd,
        )
        
        const participantFrame = frame.participantFrames[participantId]!

        let {
          totalDamageDone,
          totalDamageDoneToChampions,
          totalDamageTaken,
        } = participantFrame.damageStats

        let damageDealtToChampions = totalDamageDoneToChampions - previousFrameDamageDealtToChampions
        let damageTaken = totalDamageTaken - previousFrameDamageTaken
        let netDamageTraded = damageDealtToChampions - damageTaken
        previousFrameDamageDealtToChampions = totalDamageDoneToChampions
        previousFrameDamageTaken = totalDamageTaken

        minuteAnalysis.damageDealtToChampions = damageDealtToChampions
        minuteAnalysis.damageTaken = damageTaken
        minuteAnalysis.netDamageTraded = netDamageTraded

        let totalCreepsKilled =
          participantFrame.minionsKilled
          + participantFrame.jungleMinionsKilled
        let creepsKilled = totalCreepsKilled - previousFrameCreepsKilled
        previousFrameCreepsKilled = totalCreepsKilled
        
        minuteAnalysis.creepsKilled += creepsKilled

        let goldGained = participantFrame.totalGold - previousFrameTotalGold
        previousFrameTotalGold = participantFrame.totalGold
        
        minuteAnalysis.goldGained += goldGained

        let xpGained = participantFrame.xp - previousFrameTotalXp
        previousFrameTotalXp = participantFrame.xp

        minuteAnalysis.xpGained += xpGained
        
        for (const event of frame.events) {
          if (event.type == 'CHAMPION_KILL') {
            let killed = event.killerId == participantId
            let died = event.victimId == participantId
            let assisted = event.assistingParticipantIds?.includes(participantId)
            let killGold = (event.bounty ?? 0) + (event.shutdownBounty ?? 0)
            if (killed) {
              ++minuteAnalysis.kills
              minuteAnalysis.bountiesClaimed.push(killGold)
            }
            if (died) {
              ++minuteAnalysis.deaths
              minuteAnalysis.bountiesGiven.push(killGold)
            }
            if (assisted) {
              ++minuteAnalysis.assists
              minuteAnalysis.bountiesHelpedClaim.push(killGold)
            }
          }

          if (event.type == 'ELITE_MONSTER_KILL') {
            let killed = event.killerTeamId == teamId
            let gave = event.killerTeamId != teamId
            if (event.monsterType == 'BARON_NASHOR') {
              if (killed) ++minuteAnalysis.baronsKilled
              if (gave) ++minuteAnalysis.baronsGiven
            }
            if (event.monsterType == 'RIFTHERALD') {
              if (killed) ++minuteAnalysis.heraldsKilled
              if (gave) ++minuteAnalysis.heraldsGiven
            }
            if (event.monsterType == 'DRAGON') {
              if (killed) ++minuteAnalysis.dragonsKilled
              if (gave) ++minuteAnalysis.dragonsGiven
            }
          }

          // objective bounties
          if (event.bounty) {
            let killed = event.killerTeamId == teamId
            let gave = event.killerTeamId != teamId
            if (
              event.type == 'ELITE_MONSTER_KILL' ||
              event.type == 'BUILDING_KILL'
            ) {
              if (killed) {
                minuteAnalysis.objectiveBountiesGoldGained += event.bounty
                minuteAnalysis.objectiveBountiesClaimed.push(event.bounty)
              }
              if (gave) {
                minuteAnalysis.objectiveBountiesGoldGiven += event.bounty
                minuteAnalysis.objectiveBountiesGiven.push(event.bounty)
              }
            }
          }
        }

        if (players[puuid] == null) players[puuid] = []
        players[puuid]!.push(minuteAnalysis)
      }
    }

    return players
  }

  #getPlayerMinuteEvaluation(
    playerMinuteAnalysisAggregate: PlayerMinuteAnalysisAggregate,
  ): PlayerMinuteEvaluation {
    const product: PlayerMinuteEvaluation = {}

    for (const puuid in playerMinuteAnalysisAggregate) {
      const game = playerMinuteAnalysisAggregate[puuid]!
      for (const aggregate of game) {
        let key: keyof typeof aggregate
        for (key in aggregate) {
          if (
            key != 'timestampBegin' &&
            key != 'timestampEnd' &&
            key != 'sampleSize'
          ) {
            let value = aggregate[key]
            let [min, max, mean] = value
            
            // ...
          }
        }
      }
    }

    return product
  }

  #getPlayerMinuteAnalysisAggregate(
    playerMinuteAnalysisSamples: PlayerMinuteAnalysisSamples,
  ): PlayerMinuteAnalysisAggregate {
    const product: PlayerMinuteAnalysisAggregate = {}
    const percentileMinMax = 90

    for (const puuid in playerMinuteAnalysisSamples) {
      const game = playerMinuteAnalysisSamples[puuid]
      for (let timestampEnd in game) {
        const samples = game[timestampEnd]!
        const aggregate = this.#createMinuteAnalysisAggregate(
          samples.timestampBegin,
          samples.timestampEnd,
          samples.sampleSize,
        )

        let key: keyof typeof aggregate
        for (key in aggregate) {
          let value = aggregate[key]
          if (!Array.isArray(value)) continue

          if (
            key != 'timestampBegin' &&
            key != 'timestampEnd' &&
            key != 'sampleSize'
          ) {
            let numArr = samples[key]
            if (numArr.length == 0) {
              aggregate[key] = [0, 0, 0]
            } else {
              aggregate[key] = [
                min(numArr, percentileMinMax),
                max(numArr, percentileMinMax),
                mean(numArr),
              ]
            }
          }
        }

        if (product[puuid] == null) product[puuid] = []
        product[puuid]!.push(aggregate)

        // TEMP
        // product[puuid]!.push({
        //   timestampBegin: samples.timestampBegin,
        //   timestampEnd: samples.timestampEnd,
        //   kills: [
        //     min(samples.kills, percentileMinMax),
        //     max(samples.kills, percentileMinMax),
        //     mean(samples.kills),
        //   ],
        //   deaths: [
        //     min(samples.deaths, percentileMinMax),
        //     max(samples.deaths, percentileMinMax),
        //     mean(samples.deaths),
        //   ],
        //   assists: [
        //     min(samples.assists, percentileMinMax),
        //     max(samples.assists, percentileMinMax),
        //     mean(samples.assists),
        //   ],
        //   bountiesClaimed: [
        //     min(samples.bountiesClaimed, percentileMinMax),
        //     max(samples.bountiesClaimed, percentileMinMax),
        //     mean(samples.bountiesClaimed),
        //   ],
        //   bountiesGiven: [
        //     min(samples.bountiesGiven, percentileMinMax),
        //     max(samples.bountiesGiven, percentileMinMax),
        //     mean(samples.bountiesGiven),
        //   ],
        //   bountiesHelpedClaim: [
        //     min(samples.bountiesHelpedClaim, percentileMinMax),
        //     max(samples.bountiesHelpedClaim, percentileMinMax),
        //     mean(samples.bountiesHelpedClaim),
        //   ],
        //   damageDealtToChampions: [
        //     min(samples.damageDealtToChampions, percentileMinMax),
        //     max(samples.damageDealtToChampions, percentileMinMax),
        //     mean(samples.damageDealtToChampions),
        //   ],
        //   damageTaken: [
        //     min(samples.damageTaken, percentileMinMax),
        //     max(samples.damageTaken, percentileMinMax),
        //     mean(samples.damageTaken),
        //   ],
        //   netDamageTraded: [
        //     min(samples.netDamageTraded, percentileMinMax),
        //     max(samples.netDamageTraded, percentileMinMax),
        //     mean(samples.netDamageTraded),
        //   ],
        //   creepsKilled: [
        //     min(samples.creepsKilled, percentileMinMax),
        //     max(samples.creepsKilled, percentileMinMax),
        //     mean(samples.creepsKilled),
        //   ],
        //   goldGained: [
        //     min(samples.goldGained, percentileMinMax),
        //     max(samples.goldGained, percentileMinMax),
        //     mean(samples.goldGained),
        //   ],
        //   xpGained: [
        //     min(samples.xpGained, percentileMinMax),
        //     max(samples.xpGained, percentileMinMax),
        //     mean(samples.xpGained),
        //   ],
        //   baronsKilled: [
        //     min(samples.baronsKilled, percentileMinMax),
        //     max(samples.baronsKilled, percentileMinMax),
        //     mean(samples.baronsKilled),
        //   ],
        //   baronsGiven: [
        //     min(samples.baronsGiven, percentileMinMax),
        //     max(samples.baronsGiven, percentileMinMax),
        //     mean(samples.baronsGiven),
        //   ],
        //   heraldsKilled: [
        //     min(samples.heraldsKilled, percentileMinMax),
        //     max(samples.heraldsKilled, percentileMinMax),
        //     mean(samples.heraldsKilled),
        //   ],
        //   heraldsGiven: [
        //     min(samples.heraldsGiven, percentileMinMax),
        //     max(samples.heraldsGiven, percentileMinMax),
        //     mean(samples.heraldsGiven),
        //   ],
        //   dragonsKilled: [
        //     min(samples.dragonsKilled, percentileMinMax),
        //     max(samples.dragonsKilled, percentileMinMax),
        //     mean(samples.dragonsKilled),
        //   ],
        //   dragonsGiven: [
        //     min(samples.dragonsGiven, percentileMinMax),
        //     max(samples.dragonsGiven, percentileMinMax),
        //     mean(samples.dragonsGiven),
        //   ],
        //   objectiveBountiesGoldGained: [
        //     min(samples.objectiveBountiesGoldGained, percentileMinMax),
        //     max(samples.objectiveBountiesGoldGained, percentileMinMax),
        //     mean(samples.objectiveBountiesGoldGained),
        //   ],
        //   objectiveBountiesGoldGiven: [
        //     min(samples.objectiveBountiesGoldGiven, percentileMinMax),
        //     max(samples.objectiveBountiesGoldGiven, percentileMinMax),
        //     mean(samples.objectiveBountiesGoldGiven),
        //   ],
        //   objectiveBountiesClaimed: [
        //     min(samples.objectiveBountiesClaimed, percentileMinMax),
        //     max(samples.objectiveBountiesClaimed, percentileMinMax),
        //     mean(samples.objectiveBountiesClaimed),
        //   ],
        //   objectiveBountiesGiven: [
        //     min(samples.objectiveBountiesGiven, percentileMinMax),
        //     max(samples.objectiveBountiesGiven, percentileMinMax),
        //     mean(samples.objectiveBountiesGiven),
        //   ],
        //   sampleSize: samples.sampleSize,
        // })
      }
    }

    return product
  }

  #combinePlayerMinuteAnalysis(
    base: PlayerMinuteAnalysisSamples | null,
    playerMinuteAnalysis: PlayerMinuteAnalysis[]
  ): PlayerMinuteAnalysisSamples {
    const product: PlayerMinuteAnalysisSamples = base ?? {}

    for (const players of playerMinuteAnalysis) {
      for (const puuid in players) {
        const game = players[puuid]!
        if (product[puuid] == null) product[puuid] = {}
        const player = product[puuid]!

        for (const minute of game) {
          // initialize samples
          if (player[minute.timestampEnd] == null) {
            player[minute.timestampEnd] = this.#createMinuteAnalysisSamples(
              minute.timestampBegin,
              minute.timestampEnd,
            )
          }
          const minuteSamples = player[minute.timestampEnd]!
          
          // add to samples
          let key: keyof typeof minute
          for (key in minute) {
            let value = minute[key]
            let samplesArr = minuteSamples[key]
            if (!Array.isArray(samplesArr)) continue

            if (typeof value == 'number') samplesArr.push(value)
            else samplesArr.push(...value)
          }
          ++minuteSamples.sampleSize
        }
      }
    }

    return product
  }

  #createMinuteAnalysis(
    timestampBegin: number,
    timestampEnd: number,
  ): MinuteAnalysis {
    return {
      timestampBegin,
      timestampEnd,
      kills: 0,
      deaths: 0,
      assists: 0,
      bountiesClaimed: [],
      bountiesGiven: [],
      bountiesHelpedClaim: [],
      damageDealtToChampions: 0,
      damageTaken: 0,
      netDamageTraded: 0,
      creepsKilled: 0,
      goldGained: 0,
      xpGained: 0,
      baronsKilled: 0,
      baronsGiven: 0,
      heraldsKilled: 0,
      heraldsGiven: 0,
      dragonsKilled: 0,
      dragonsGiven: 0,
      objectiveBountiesGoldGained: 0,
      objectiveBountiesGoldGiven: 0,
      objectiveBountiesClaimed: [],
      objectiveBountiesGiven: [],
    }
  }

  #createMinuteAnalysisSamples(
    timestampBegin: number,
    timestampEnd: number,
  ): MinuteAnalysisSamples {
    return {
      timestampBegin,
      timestampEnd,
      kills: [],
      deaths: [],
      assists: [],
      bountiesClaimed: [],
      bountiesGiven: [],
      bountiesHelpedClaim: [],
      damageDealtToChampions: [],
      damageTaken: [],
      netDamageTraded: [],
      creepsKilled: [],
      goldGained: [],
      xpGained: [],
      baronsKilled: [],
      baronsGiven: [],
      heraldsKilled: [],
      heraldsGiven: [],
      dragonsKilled: [],
      dragonsGiven: [],
      objectiveBountiesGoldGained: [],
      objectiveBountiesGoldGiven: [],
      objectiveBountiesClaimed: [],
      objectiveBountiesGiven: [],
      sampleSize: 0,
    }
  }

  #createMinuteAnalysisAggregate(
    timestampBegin: number,
    timestampEnd: number,
    sampleSize: number,
  ): MinuteAnalysisAggregate {
    return {
      timestampBegin,
      timestampEnd,
      kills: [0, 0, 0],
      deaths: [0, 0, 0],
      assists: [0, 0, 0],
      bountiesClaimed: [0, 0, 0],
      bountiesGiven: [0, 0, 0],
      bountiesHelpedClaim: [0, 0, 0],
      damageDealtToChampions: [0, 0, 0],
      damageTaken: [0, 0, 0],
      netDamageTraded: [0, 0, 0],
      creepsKilled: [0, 0, 0],
      goldGained: [0, 0, 0],
      xpGained: [0, 0, 0],
      baronsKilled: [0, 0, 0],
      baronsGiven: [0, 0, 0],
      heraldsKilled: [0, 0, 0],
      heraldsGiven: [0, 0, 0],
      dragonsKilled: [0, 0, 0],
      dragonsGiven: [0, 0, 0],
      objectiveBountiesGoldGained: [0, 0, 0],
      objectiveBountiesGoldGiven: [0, 0, 0],
      objectiveBountiesClaimed: [0, 0, 0],
      objectiveBountiesGiven: [0, 0, 0],
      sampleSize,
    }
  }
}

export interface MinuteAnalysis {
  /** Seconds-timestamp. */
  timestampBegin: number
  /** Seconds-timestamp. */
  timestampEnd: number
  kills: number
  deaths: number
  assists: number
  bountiesClaimed: number[]
  bountiesGiven: number[]
  bountiesHelpedClaim: number[]
  damageDealtToChampions: number
  damageTaken: number
  netDamageTraded: number
  creepsKilled: number
  goldGained: number
  xpGained: number
  baronsKilled: number
  baronsGiven: number
  heraldsKilled: number
  heraldsGiven: number
  dragonsKilled: number
  dragonsGiven: number
  objectiveBountiesGoldGained: number
  objectiveBountiesGoldGiven: number
  objectiveBountiesClaimed: number[]
  objectiveBountiesGiven: number[]
}

export interface MinuteAnalysisSamples {
  /** Seconds-timestamp. */
  timestampBegin: number
  /** Seconds-timestamp. */
  timestampEnd: number
  kills: number[]
  deaths: number[]
  assists: number[]
  bountiesClaimed: number[]
  bountiesGiven: number[]
  bountiesHelpedClaim: number[]
  damageDealtToChampions: number[]
  damageTaken: number[]
  netDamageTraded: number[]
  creepsKilled: number[]
  goldGained: number[]
  xpGained: number[]
  baronsKilled: number[]
  baronsGiven: number[]
  heraldsKilled: number[]
  heraldsGiven: number[]
  dragonsKilled: number[]
  dragonsGiven: number[]
  objectiveBountiesGoldGained: number[]
  objectiveBountiesGoldGiven: number[]
  objectiveBountiesClaimed: number[]
  objectiveBountiesGiven: number[]
  sampleSize: number
}

/** `[min90th, max90th, mean]` */
export interface MinuteAnalysisAggregate {
  /** Seconds-timestamp. */
  timestampBegin: number
  /** Seconds-timestamp. */
  timestampEnd: number
  kills: [number, number, number]
  deaths: [number, number, number]
  assists: [number, number, number]
  bountiesClaimed: [number, number, number]
  bountiesGiven: [number, number, number]
  bountiesHelpedClaim: [number, number, number]
  damageDealtToChampions: [number, number, number]
  damageTaken: [number, number, number]
  netDamageTraded: [number, number, number]
  creepsKilled: [number, number, number]
  goldGained: [number, number, number]
  xpGained: [number, number, number]
  baronsKilled: [number, number, number]
  baronsGiven: [number, number, number]
  heraldsKilled: [number, number, number]
  heraldsGiven: [number, number, number]
  dragonsKilled: [number, number, number]
  dragonsGiven: [number, number, number]
  objectiveBountiesGoldGained: [number, number, number]
  objectiveBountiesGoldGiven: [number, number, number]
  objectiveBountiesClaimed: [number, number, number]
  objectiveBountiesGiven: [number, number, number]
  sampleSize: number
}

export interface MinuteEvaluation {
  /** A final score for the minute. */
  [timestampEnd: number]: number
}

export interface PlayerMinuteAnalysis {
  [puuid: string]: MinuteAnalysis[]
}

export interface PlayerMinuteAnalysisSamples {
  [puuid: string]: {
    [timestampEnd: string]: MinuteAnalysisSamples
  }
}

export interface PlayerMinuteAnalysisAggregate {
  [puuid: string]: MinuteAnalysisAggregate[]
}

export interface PlayerMinuteEvaluation {
  [puuid: string]: MinuteEvaluation[]
}
