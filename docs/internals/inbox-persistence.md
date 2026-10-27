Inbox persistence
=================

The federation package stores accepted remote resources through
*packages/federation/src/inbox-persist.ts*. Transport observations are recorded
separately, as described in [activity deliveries](activity-deliveries.md).

The inbox listeners store a received `Create` in `activities`, with its remote
actor and object, when:

 -  it has an ID, and its actor is not a local actor, whose activities DrFed
    stores as it sends them;
 -  its object is a `Note` or an `Article` with an ID on the origin of the
    actor, attributed to the actor, and with content, as [FEP-fe34] requires
    of an object its actor creates;
 -  its actor has an inbox;
 -  its text holds neither U+0000 nor an unpaired surrogate, which PostgreSQL
    would refuse or alter; the delivery keeps such text as received; and
 -  `createInboundRecorder()` recorded the request, which tells the listener
    what the request carried and when it arrived.

An IRI already stored is kept as it is: a `Create` received again, or by
several instances, is stored once, and nothing it carries is written then, even
an object that has not been stored yet.  One that claims another actor's object
or an IRI of another kind is not stored.  The activity and its embedded object
are stored as received, whatever terms their context uses.  DrFed looks for the
embedded object in at most 64 places of the activity, expanding the document
once for each; when it is not among them, the object is stored without its
document, and the activity's document still holds it as received. A remote
actor's `username` is its `preferredUsername`, which may be missing.

Fedify authenticates an activity before answering it with 2xx, and Fedify
2.4.3 or later refuses one whose ID is on another origin than its actors, so
every inbound delivery that was verified and answered with 2xx is linked to the
stored activity its ID names, a duplicate Fedify skips included.  An outbound
delivery is linked to the activity it sends.

The serializers exported by `@drfed/federation/object` are shared by GraphQL
mutations and ActivityPub dispatchers. Load rows with the matching selection
before serializing them, so stored documents and served objects agree.

Accepted legacy writers also capture retained history in the same transaction.
See [resource revisions](resource-revisions.md) for the difference between
current typed rows, retained snapshots and delivery receipts.

[FEP-fe34]: https://w3id.org/fep/fe34
