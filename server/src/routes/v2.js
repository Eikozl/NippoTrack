const express = require('express');
const controller = require('../controllers/v2Controller');

const router = express.Router();
router.route('/goals').get(controller.listGoals).post(controller.createGoal);
router.route('/goals/:id').put(controller.updateGoal).delete(controller.deleteGoal);
router.route('/content/:id/links').get(controller.contentLinks.list).put(controller.contentLinks.replace);
router.route('/notes/:id/links').get(controller.noteLinks.list).put(controller.noteLinks.replace);
router.route('/tags/:id/links').get(controller.tagLinks.list).put(controller.tagLinks.replace);
for (const [path, handlers] of Object.entries({ '/content': controller.content, '/notes': controller.notes, '/tags': controller.tags })) {
  router.route(path).get(handlers.list).post(handlers.create);
  router.route(`${path}/:id`).put(handlers.update).delete(handlers.remove);
}
module.exports = router;
