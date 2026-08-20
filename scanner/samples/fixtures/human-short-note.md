Team,

The deploy last night went sideways. Here's what happened and what I'm doing.

At 11:40pm the migration locked the orders table for about four minutes. Checkout
was returning 500s that whole time. We lost roughly 200 orders — support has the
list and is reaching out individually with a discount code.

Root cause: the migration added a column with a default, which rewrites the whole
table on Postgres 10. We're on 14 where that's supposed to be instant, but the
column had a volatile default (now()), which still forces a rewrite. I did not
know that. I do now.

Two changes. First, migrations touching tables over a million rows go through a
review with me or Sana. Second, I'm adding a check to CI that flags volatile
defaults specifically.

Sorry about the mess. Ask me anything.

— Dana
