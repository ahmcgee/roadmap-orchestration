# The shelf's page

The page neighbours open on their phones, usually from the QR code taped to the shelf. Today it lists what is on the
shelf and nothing more: you still have to walk round and hope the book you saw is there. The page's next job is to let
a neighbour claim a book before they walk round.

The look is the shelf's own: the paper colour, the ink and the hand lettering of the flyers Dev tapes to it. Neighbours
know it from the street, so the page keeps it.

## What is on the shelf

Every book shows its title, its author, its condition in the giver's words and the day it arrived. A reserved book
stays on the list, marked reserved, but never shows who reserved it: neighbours know each other, and a name on a public
page is not ours to show. Neighbours look for a book by its title or its author, so the page lets them search by
either, and a search that finds nothing says so and offers the whole shelf again.

```rules
T-1: The shelf's page `/` lists every book on the shelf with its title, author, condition and the day it arrived.
T-2: A reserved book is marked reserved on the shelf's page and never shows who reserved it.
T-3: A neighbour searches the shelf by title or author; a search with no match says so and links back to the whole shelf.
```

## Reserving a book

A neighbour picks a free book, gives their first name and gets a confirmation that says which book is theirs, that it
is waiting on the shelf at 14 Oak Street, and until when. Collection is on Saturdays and Sundays, from nine to six, so
a reservation made on a Thursday holds until Sunday at six; one made on a Saturday morning also holds until Sunday at
six. The confirmation is the end of the flow: there is nothing to sign up to and no account.

A book is never promised twice. If two neighbours try to reserve the same book, the second is told plainly that it has
just been taken and is offered the rest of the shelf; their name is not kept.

```rules
T-4: A neighbour reserves a free book from the shelf's page by giving a first name, and the confirmation names the book, the shelf's address and the end of the collection window it holds until.
T-5: The collection window is Saturday and Sunday, 09:00 to 18:00 local time; a reservation holds until the end of the next window that has not ended.
T-6: A reservation of a book that is already reserved is refused with a message saying it has just been taken and a link back to the shelf; nothing is recorded.
T-7: A reservation without a first name is refused with a message saying a first name is needed, and the neighbour's choice of book is kept.
```
