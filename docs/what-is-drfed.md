What is DrFed?
==============

DrFed is a web-based platform for debugging ActivityPub interoperability
failures. It helps you understand why federation breaks between implementations
and reproduce the problem in a controlled environment.


Who is it for?
--------------

Developers building ActivityPub applications or investigating federation
problems between servers.


How does it help?
-----------------

DrFed gives you workspace instances that run as real ActivityPub servers. You
can create actors, receive activities, send test activities to remote servers,
and inspect what happened.


What does it support?
---------------------

 -  Object inspection and WebFinger lookup.
 -  Signature debugging for four signing schemes used in the Fediverse.
 -  Content-type validation.
 -  JSON-LD tools for comparing how implementations process a document.
 -  Hosted use and self-hosting.


License
-------

DrFed is free software licensed under the
[GNU Affero General Public License v3 or later].

[GNU Affero General Public License v3 or later]: https://www.gnu.org/licenses/agpl-3.0.html
