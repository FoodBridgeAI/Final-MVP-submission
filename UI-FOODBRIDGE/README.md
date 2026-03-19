# UI-FOODBRIDGE

A procurement planning UI built for PSU's Housing & Food Services. Sits on top of FoodPro to give Central Procurement an intelligent planning table — with ML-assisted risk flags, per-operation demand breakdowns, and real-time order calculations.

---

## Before You Start

Make sure you have these installed:

| Tool | Check | Download |
|------|-------|----------|
| **Node.js** (v18+) | `node -v` in terminal | [nodejs.org](https://nodejs.org) |
| **Git** | `git --version` in terminal | [git-scm.com](https://git-scm.com) |

If those commands return a version number you're good. If not, download and install them first.

---

## How to Run

Copy and paste these into your terminal **one line at a time:**

```bash
git clone https://github.com/FoodBridgeAI/UI-FOODBRIDGE.git
```
```bash
cd UI-FOODBRIDGE
```
```bash
npm install
```
```bash
npm run dev
```

Then open your browser and go to the link your terminal shows — it will look like this:

```
http://localhost:5173
```

> ⚠️ Keep the terminal running while you use the app. Closing it stops the server.

---

## Getting the Latest Changes

When a teammate pushes updates, run these to sync:

```bash
git pull
npm install
npm run dev
```

---

## Something Not Working?

| Error | Fix |
|-------|-----|
| `command not found: npm` | Install Node.js from nodejs.org |
| `npm install` fails | Make sure you ran `cd UI-FOODBRIDGE` first |
| Nothing shows at localhost:5173 | Make sure `npm run dev` is still running in your terminal |
| Blank white screen | Press F12 in browser → Console tab → screenshot the error |

---

## Project Structure

```
UI-FOODBRIDGE/
├── src/
│   ├── App.jsx          ← main planning table UI
│   ├── FoodBridge.jsx   ← FoodBridge components
│   └── main.jsx         ← entry point
├── index.html
├── package.json
└── vite.config.js
```

---

Built by **FoodBridgeAI** · Penn State HFS Procurement Planning
