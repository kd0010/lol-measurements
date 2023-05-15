import { Region, TeamId } from 'lol-constants'
import { Cache } from '../../lol-personal-db'

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
  
  async analyzeGame(
    gameId: number,
  ) {
    const timeline = await Cache.getMatchTimeline(gameId)

    const players: {
      [participantId: string]: MinuteAnalysis[]
    } = {}

    for (const {
      participantId,
      puuid,
    } of timeline.data.participants) {
      const teamId: TeamId = [1, 2, 3, 4, 5].includes(participantId) ? 100 : 200
      let previousFrameDamageDealtToChampions = 0
      let previousFrameDamageTaken = 0
      let previousFrameCreepsKilled = 0
      let previousFrameTotalGold = 0
      let previousFrameTotalXp = 0

      for (const frame of timeline.data.frames) {
        let timestampEnd = Math.floor(frame.timestamp / 1000)
        let timestampBegin = Math.max(0, timestampEnd - 60)
        const minuteAnalysis: MinuteAnalysis = {
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

        if (players[participantId] == null) players[participantId] = []
        players[participantId]!.push(minuteAnalysis)
      }
    }

    return players
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
