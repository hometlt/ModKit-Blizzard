function timelineToJson(timeline) {
  const { stats, ...rest } = timeline;
  return { ...rest, statsEntries: [...stats.entries()] };
}
function timelineFromJson(json) {
  const { statsEntries, ...rest } = json;
  return { ...rest, stats: new Map(statsEntries) };
}
export {
  timelineFromJson,
  timelineToJson
};
