// routes/index.js
// نقطة تجميع واحدة لكل الـ routers. أي route جديد بتضيفه، بتسجله هون بس —
// server.js بيصير ما له علاقة أبداً بتفاصيل أي route.

const express = require('express');

module.exports = function (deps) {
  const router = express.Router();

  router.use(require('./meta.routes')(deps));
  router.use(require('./auth.routes')(deps));
  router.use(require('./technicians.routes')(deps));
  router.use(require('./requests.routes')(deps));
  router.use(require('./offers.routes')(deps));
  router.use(require('./chat.routes')(deps));
  router.use(require('./topups.routes')(deps));
  router.use(require('./admin.routes')(deps));
  router.use(require('./support.routes')(deps));
  router.use(require('./notifications.routes')(deps));

  return router;
};
