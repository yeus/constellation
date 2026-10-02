import type {
  ShareBatteryPolicy,
  ShareNetworkPolicy,
  SharePauseReason,
  SharePublication,
} from '../shareDraft.ts'

export type NetworkRestriction = SharePauseReason | 'unknown'
export type SharePauseState = SharePauseReason | 'unknown'

export const sharePauseReason = (
  share: { publication: SharePublication; network: ShareNetworkPolicy },
  restriction: NetworkRestriction | undefined,
): SharePauseState | undefined => {
  if (share.publication !== 'background' || share.network !== 'pause-when-metered') {
    return undefined
  }
  return restriction
}

export const backgroundSharePolicy = (
  publication: SharePublication,
  battery: ShareBatteryPolicy,
  network: ShareNetworkPolicy,
): { battery: ShareBatteryPolicy; network: ShareNetworkPolicy } =>
  publication === 'background' ? { battery, network } : { battery: 'balanced', network: 'always' }
