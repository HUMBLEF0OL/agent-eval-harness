export function rankedScores(scores: number[]): number[] {
  return scores.sort((a, b) => b - a);
}
