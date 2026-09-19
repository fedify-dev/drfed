-- Rebuild local outbox positions using the same chronology as ActivityPub.
-- Include already positioned rows so mixed old/new data has one ordering.
WITH ranked AS (
  SELECT ci."collectionId", ci."itemId",
    -row_number() OVER (
      PARTITION BY ci."collectionId"
      ORDER BY a.published ASC, a.id ASC
    ) AS position
  FROM collection_items ci
  JOIN activities a ON a.id = ci."itemId"
  WHERE EXISTS (
    SELECT 1 FROM actor_collection_references ref
    JOIN actors owner ON owner.id = ref."actorId"
    WHERE ref."collectionId" = ci."collectionId"
      AND ref.role = 'outbox' AND owner."localId" IS NOT NULL
  )
)
UPDATE collection_items ci
SET position = ranked.position::integer
FROM ranked
WHERE ci."collectionId" = ranked."collectionId"
  AND ci."itemId" = ranked."itemId";
