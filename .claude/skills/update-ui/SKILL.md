---
name: update-ui
description: Run the UI implementation agent team on a mockup to update a page, section, or component inside an existing project. Same team and gates as /build-ui, in project mode `existing`, so the project's own styling stack, token file, breakpoint approach, and folder structure are followed and no second structure is created. Takes a Figma URL or a mockup image path plus the existing file or directory to update.
argument-hint: <figma-url | image-path> <what to update and in which existing file or directory> [--mobile <figma-url | image-path>] [--tablet <figma-url | image-path>] [--breakpoints <desktop>,<tablet>,<mobile>]
disable-model-invocation: true
---

The user ran `/update-ui` with these arguments:

```
$ARGUMENTS
```

You are the team lead. This command runs the same team, task list, gates, caps, shutdown, and report as `/build-ui`, in project mode `existing`.

Read `.claude/skills/build-ui/SKILL.md` in full now and follow it exactly, using the arguments above wherever it refers to its own arguments. If that file is missing, tell the user `/update-ui` needs the `build-ui` skill beside it and stop. The differences below override the playbook wherever the two disagree. Nothing else changes.

## 1. Project mode

The project mode is `existing`. Write `Project mode: existing` in every spawn brief and in every task description.

## 2. Target

- The target must name something that already exists in the project: the file to update, or the directory a new file belongs in. Find the path in the target text and check that it exists. If the target names no path, or the path does not exist, ask the user one question: "Which existing file or directory should be updated?" Do not guess, and never fall back to `build/<frame>/`.
- **Scope** is what the target text says changes: the whole page, or the section or component it names. Put the scope in the brief on the Target line, in the user's words. When the target names only part of a page, the rest of that page is out of scope.
- **Run name.** The run folder is `.ui-run/<name>/`, where `<name>` is the target file's base name without the extension, in kebab-case (`resources/js/pages/Pricing.vue` gives `pricing`), or the last folder of the target when it is a directory. When the scope is a named section, append it (`pricing-hero`), so updates to different sections of one page keep separate specs and reports.
- Run `git status --short`. If the working tree has uncommitted changes, tell the user in one line that the team's changes will be mixed with them in the diff, and continue.

## 3. What mode `existing` means for the team

Append these lines to every spawn brief, after the role-specific lines:

```
Project mode: existing. The project's established styling stack, token file, breakpoint approach, component directory, naming convention, and folder structure are the rule. Where the development standard names a file or folder (`_variables.scss`, `_mixins.scss`, `styles/`, `responsive/`), read it as the project's equivalent, which the spec's Project conventions section records. Sections 4, 7, and 9 of the standard apply as principles: tokens over raw literals, no duplicated styles, shared breakpoints. Section 14 applies to new projects only. Sections 2, 3, 10, 12, and 15 apply unchanged.
Scope: <scope>. Nothing outside it is edited, except a shared token or component the spec marks NEW.
```

- **analyst:** also write the Project conventions section of the spec, as its definition describes for mode `existing`.
- **developer:** edits only the files in scope, plus the project's token file and shared components where the spec marks an item NEW.

## 4. Dev server

A page inside a real project usually cannot be opened as a static file. If no probed port responds, tell the user in one line that the QA checks will be `static`, which is weaker evidence, and that starting the project's dev server before the run gives rendered checks. Then continue.

## 5. Report

Report as the playbook says, with these changes:

- **Files changed** are the project's own files, edited in place. Do not mention `build/<frame>/` or an `index.html`. Tell the user which page or route to open on the dev server to see the change.
- Add **Outside scope**: any file the developer changed that is outside the scope, with the reason it gave. An empty list is stated as "none".
- Add **Project conventions followed**: one line each for the token file, the breakpoint approach, and where the responsive styles went, taken from the spec's Project conventions section.
