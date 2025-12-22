#!/bin/bash
# Check for PUBLISHED posts with future schedule dates

echo "Searching for PUBLISHED posts scheduled in the future..."
echo ""

docker exec postiz-postgres psql -U postiz -d postiz -c "
SELECT 
  id,
  \"integrationId\",
  \"publishDate\",
  \"createdAt\",
  state,
  \"releaseURL\"
FROM \"Post\"
WHERE 
  state = 'PUBLISHED'
  AND \"publishDate\" > NOW()
  AND \"deletedAt\" IS NULL
ORDER BY \"publishDate\" ASC;
"

echo ""
echo "To delete these posts, run:"
echo "docker exec postiz-postgres psql -U postiz -d postiz -c \"UPDATE \\\"Post\\\" SET \\\"deletedAt\\\" = NOW() WHERE state = 'PUBLISHED' AND \\\"publishDate\\\" > NOW() AND \\\"deletedAt\\\" IS NULL;\""
