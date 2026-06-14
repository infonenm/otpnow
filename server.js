services:
  - type: web
    name: otpnow
    runtime: node
    buildCommand: npm install
    startCommand: node server.js
    envVars:
      - key: FIREBASE_SERVICE_ACCOUNT
        sync: false
      - key: FIREBASE_DATABASE_URL
        sync: false
      - key: FIREBASE_CONFIG
        sync: false
      - key: DASHBOARD_SECRET
        generateValue: true
      - key: NODE_ENV
        value: production
