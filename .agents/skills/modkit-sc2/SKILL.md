---
name: modkit-sc2
description: Inspect a user-selected StarCraft II .SC2Map, .SC2Mod, or .SC2Campaign through Modkit, including dependency-resolved data, cards, relations, calculations, localized strings, Galaxy, Triggers, Layouts, maps, M3/M3A, and knowledge. Do not search extracted game or CASC/MPQ data directly.
---

# Inspect StarCraft II through Modkit

Open the selected map, mod, or campaign as one Modkit subject so dependency merging, schema identity,
localization, and resource resolution all use the same pinned snapshot.

## Workflow

1. Use `modkit.capabilities` when the active SC2 extensions or operations are unknown.
2. Open the exact user-selected `.SC2Map`, `.SC2Mod`, or `.SC2Campaign` with
   `modkit.open_subject`, then call `modkit.inspect`. When an installed CASC subject returns map
   `selectionCandidates`, continue the same handle with `modkit.open_selection` and an exact
   returned `selectionId`; never guess among multiple maps.
3. Call `modkit.list_subjects` on the opened map/mod/campaign handle, filter by exact kind or
   text only to narrow the bounded list, and pass an exact returned `subjectId` to
   `modkit.select_subject`; keep the resulting entity handle tied to that resolved snapshot.
4. Use `modkit.subject_facts` on the entity handle for the selected entity card and
   `modkit.subject_calculations` for gameplay values; retain defaulted and missing inputs.
5. Use `modkit.relation_graph` with `view: traverse`, an exact entity ID, direction, and the smallest
   useful depth for incoming users and outgoing paths. Prefer semantic links such as Unit → Weapon
   → Effect, Unit → Abil → Effect, and producer → CAbilTrain → Unit over text matching.
6. Resolve every field explanation from the exact schema-backed `knowledgeTarget` and include the
   direct full-source link when Modkit provides one.
7. For Galaxy, Trigger, Layout, map, or M3 work, use the corresponding public Modkit inspection or
   validation operation advertised by the subject. If it is absent or reports a named remainder,
   say so; do not silently substitute a raw-file parser.
8. Close the entity handle with `modkit.close_selected_subject`, then close the parent map/mod/
   campaign handle with `modkit.close_subject`, even when an operation fails.

Never inspect the SC2 installation, extracted game-data directories, CASC, or MPQ directly to answer
a semantic question. Those sources are inputs to Modkit codecs, not an alternative authority.

Read [references/sc2-routing.md](references/sc2-routing.md) when choosing the relation direction or
the correct result surface for an SC2 question.
The machine-checkable tool order and safety boundary are in
[references/routing-contract.json](references/routing-contract.json).
