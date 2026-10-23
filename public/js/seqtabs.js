// 🎞 the sequence tabs above the timeline: at most MAX_TABS shown, in their remembered order; the open sequence is always
// one of them (Premiere keeps the current one in view) - when it is further down the list it takes the last place.
// Every sequence stays one click away in the 🎞 ▾ menu next to the tabs.
export const MAX_TABS = 5;
// list: [{ id, open }] in tab order (closed tabs already left out) -> the ones to show, same order
export function pickTabs(list, max = MAX_TABS) {
  if (list.length <= max) return list;
  const shown = list.slice(0, max), open = list.find((x) => x.open);
  if (open && !shown.includes(open)) shown[max - 1] = open;
  return shown;
}
