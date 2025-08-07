FROM node:20-slim

WORKDIR /app

COPY . .

# DEBUG: Print contents of entitlement.js to confirm it's being used
RUN echo "=== ENTITLEMENT.JS CONTENTS ===" && cat lib/entitlement.js

RUN npm install --omit=dev

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.mjs"]
