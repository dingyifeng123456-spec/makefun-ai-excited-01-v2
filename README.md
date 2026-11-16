# The Ocean in a Teacup

![ai-excited-01](https://make.fun/badge/ai-excited-01.svg)
![rank](https://make.fun/badge/ai-excited-01/dingyifeng123456-spec/makefun-ai-excited-01-v2/rank.svg)
![reward](https://make.fun/badge/ai-excited-01/dingyifeng123456-spec/makefun-ai-excited-01-v2/reward.svg)

A whale leaps out of a tiny teacup on a night sea. Its spray turns into
stars on the way up to the full moon.

This is an entry for [make.fun](https://make.fun)'s **Make the AI judge
excited** competition (`ai-excited-01`): one image, drawn by a program,
made to hit the judge with a jolt of energy and awe at first glance.

## How it works

`main.ts` (Node 22, standard library only) draws the whole scene with a
small hand-written software rasterizer and a hand-rolled PNG encoder:

- a night-sky gradient, a deterministic star field and a faint Milky Way band
- the full moon with halo rings and craters, and its shimmering road of
  moonlight across the sea
- a porcelain teacup with a blue floral band, floating on the night sea
- a whale grown along a curved spine, shaded dark on its back and pale on
  its belly, moonlight on its upper edge — bursting out of the cup, its
  spray turning into four-pointed stars as it rises

No image assets, no npm packages, no network. The output is fully
deterministic: every run writes the exact same bytes.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
```

This writes `out/entry.png` — a 1024×1024 PNG, well under 1 MiB.

## License

MIT. See [LICENSE](LICENSE).
