module.exports = {
  apps : [{
    name: 'Push_Notif_Proxy',
    script: './proxy.js',
    env: {
       // Applies regardless of which --env flag is used below.
       // Missing these was why client_cert_configured came back
       // false - this file, not package.json's "pm2" script, is
       // what actually launches the process.
       APNS_CERT_PATH: '/etc/nginx/certs/apns-cert.pem',
       APNS_KEY_PATH: '/etc/nginx/certs/apns-key.pem'
    },
    env_production: {
       NODE_ENV: "production"
    },
    env_development: {
       NODE_ENV: "development"
    }
  }]
}
