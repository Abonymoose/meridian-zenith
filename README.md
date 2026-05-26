# meridian zenith

AI-powered personalised study planner for Cambridge middle school students (Grades 6-8).

## What it does

On first visit, users:
1. Enter their name
2. Upload their report card (PDF or image) — AI reads grades and teacher comments
3. Upload their syllabus/course planner — AI maps out term topics
4. Add a Groq API key (free at console.groq.com)

Groq then generates a fully personalised 6-day weekly study plan based on their actual data — weak subjects get more focus, tasks reference real syllabus topics.

## Features

- **Personalised AI plan** — generated from report card + syllabus
- **Session timer** — 15/25/30/60/custom presets, ring animation, alarm sound
- **Task checklist** — today's tasks auto-loaded, detail panel with AI tips
- **AI-generated content** — fresh reading extracts, practice problems, exercises per task
- **AI chat** — ask follow-up questions about any task
- **Streak tracker** — daily completion streak
- **Ambient music** — brown noise, rain, focus tones (Web Audio, no ads)
- **Reward modal** — AI-generated message on day completion
- **6 themes** — light, dark, forest, ocean, midnight, warm
- **CS fundamentals roadmap** — 16-week self-study curriculum
- **Monthly projects** — 4 cross-subject projects per term
- **Settings** — edit name, API key, re-upload docs, change theme

## Stack

Pure HTML/CSS/JS. No build step, no dependencies, no server.

## Deploy to Render

1. Push to GitHub
2. Render → New → Static Site → connect repo
3. Build command: *(empty)*
4. Publish directory: `.`
5. Deploy

## API key

Uses Groq (free tier). Get a key at [console.groq.com](https://console.groq.com).
Key is stored in localStorage only — never sent anywhere except Groq's API.
