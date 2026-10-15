# SC2 inspection routing

Choose the smallest semantic surface that answers the request.

- Effective values, inheritance, names, localized strings, and origins: subject facts.
- Damage, attacks, period, DPS, cost, build time, or another derived value: subject calculations.
- “What does this use?”: outgoing graph edges.
- “Who uses this?”: incoming graph edges.
- Unit weapon/effect chain: bounded multi-hop graph starting at the Unit.
- Training path: incoming producer or Unit edge through `CAbilTrain`, retaining the command slot.
- Field meaning: exact knowledge resolution using the fact or calculation input target.
- Galaxy or Layout editor behavior: the language operation over the open workspace snapshot.
- Trigger conversion: the declared conversion operation plus its fidelity and loss report.
- Model or map questions: the model/world data source and its declared completeness.

Do not infer a linked entity merely because its id appears in text. Keep dead or unresolved edges
visible. For localization, report the requested locale and the fallback actually used.
