# The keeper's tools

Dev keeps the shelf from his laptop, in a terminal, in the repository's checkout. Today he edits `data/shelf.json` by
hand and mistypes a comma about once a month, which takes the page down until he notices. The keeper's tools replace
the hand edit: a command for each thing he does, and one small settings file for the things he changes now and then.
They are for one person who knows the shelf well and the code not at all, so their help text is the manual.

## Commands

`swapshelf` runs from the checkout (`node bin/swapshelf.js`, or `npm run swapshelf --`). It adds a book, lists the
shelf with each book's id and whether it is reserved, takes a book off, and marks a reserved book collected, which takes
it off the shelf. Its errors say what was wrong and the exact command to type instead.

```rules
T-8: `swapshelf add --title <title> --author <author> [--condition <words>]` adds a free book that arrived today and prints its id.
T-9: `swapshelf list` prints every book on the shelf with its id, title, author and whether it is reserved, and by whom.
T-10: `swapshelf remove <id>` takes a book off the shelf; `swapshelf collected <id>` marks a reserved book collected, which takes it off the shelf, and refuses a book that is not reserved.
T-11: Every `swapshelf` command answers `--help` with what it does and an example; a wrong or missing argument exits 2 with a message naming it and the command to type instead.
```

## Settings

`swapshelf.json`, at the root of the checkout (or the path in `SWAPSHELF_CONFIG`), holds what Dev changes now and
then: the shelf's name, its address line and the collection window. The page shows the name and the address, and
reservations hold until the window it sets. Without the file the page uses the shelf's own defaults: "The Oak Street
shelf", "Outside number 14" and the weekend window. A file Dev got wrong must never take the page down silently: the
server refuses to start, saying which setting is wrong and how to fix it.

```rules
T-12: `swapshelf.json` (or the path in `SWAPSHELF_CONFIG`) sets the shelf's name, its address line and the collection window; the page shows the name and address, and reservations hold until the window it sets.
T-13: Without a settings file the shelf uses its defaults: the name "The Oak Street shelf", the address "Outside number 14" and the window of T-5.
T-14: A settings file with an unknown key or a bad value stops the server at start-up with a message naming the key, what is wrong and an example of a right value.
```
