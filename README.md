<p align="center">
  <img src="media/og.png" alt="Flowline — an endless mountain" width="100%">
</p>

<h3 align="center">One endless sunlit mountain.<br>Carve clean lines, build flow, ride it forever — together.</h3>

<p align="center">
  <a href="https://flowline.games.bu.app"><b>▶&nbsp; Play now</b></a>
</p>

---

### Flips, and the top of the run

https://github.com/user-attachments/assets/ac0445e1-2f3a-4a23-a314-85dff5c0e908

### Deformable snow, up close

https://github.com/user-attachments/assets/22dedd25-b243-424d-ad7e-ba35f00c7a54

---

### Controls

| | |
|---|---|
| `A` `D` &nbsp;or&nbsp; `←` `→` | Carve |
| `S` &nbsp;or&nbsp; `↓` | Tuck — go faster |
| `W` `Space` &nbsp;or&nbsp; `↑` | Pop — jump |
| `Shift` | Grab |
| `Q` `E` | Back flip · front flip |
| `T` | Timer and splits |
| `R` | Restart |
| `P` `Esc` | Pause |
| `M` | Music |
| `?` | Help |

Phones and tablets get on-screen controls automatically. Flips are keyboard only, and landing one badly hurts.

### Run it locally

The whole game is one file, already built and committed: **[`flowline.html`](flowline.html)** (about 750 KB). Clone the repo, or use the download button on that file, and open it in any browser. No server, no install, no assets folder.

```sh
git clone https://github.com/Alezander9/Flowline.git
open Flowline/flowline.html
```

To rebuild it from `src/` after a change, Python 3 is the only requirement — no bundler, no npm, no dependencies:

```sh
python3 build.py
```

The terrain, trees, snow, sky and music are all generated in code from a seed, so everyone riding the same seed rides the same mountain.

### Multiplayer

The client (`src/net.js`) expects a websocket relay at `wss://<host>/ws/<room>`. With one, riders share a mountain and can see each other's lines. Without one, the game runs single player.

### License

MIT — see [LICENSE](LICENSE).
