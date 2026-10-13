export const suggestedPeerName = (seed: string): string => {
  const adjectives = ['Amber', 'Bright', 'Calm', 'Gentle', 'Lucky', 'Quiet', 'Silver', 'Sunny']
  const nouns = ['Badger', 'Comet', 'Finch', 'Fox', 'Heron', 'Otter', 'Robin', 'Willow']
  let hash = 2166136261
  for (const character of seed) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619)
  return `${adjectives[(hash >>> 0) % adjectives.length]} ${nouns[((hash >>> 8) >>> 0) % nouns.length]}`
}
