---
links:
  '#183': https://github.com/fedify-dev/drfed/issues/183
  '#184': https://github.com/fedify-dev/drfed/pull/184
---
 -  Fixed actor, instance, and actor and object creation pages that kept
    showing the previous actor or instance when moving within the web UI to
    another page of the same kind.  The object creation form no longer
    submits with an actor of the previously shown instance, and the page
    title now follows the page shown.  An actor or object creation that
    finishes after leaving its page no longer changes the page shown and is
    reported in a notification naming its instance.
    [[#183], [#184] by Hyeonseo Kim]
