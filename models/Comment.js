const mongoose = require('mongoose');

const AttachmentSchema = new mongoose.Schema({
  url:        { type: String, required: true },
  public_id:  { type: String, required: true }, // Cloudinary asset id, needed to delete it later
  filename:   { type: String, required: true },
  size:       { type: Number, default: 0 },
  mimetype:   { type: String, default: '' },
}, { _id: false });

const CommentSchema = new mongoose.Schema({
  task_id:    { type: mongoose.Schema.Types.ObjectId, ref: 'Task', required: true },
  author_id:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  body:       { type: String, default: '' },
  attachments: { type: [AttachmentSchema], default: [] },
  edited:     { type: Boolean, default: false },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

CommentSchema.index({ task_id: 1, created_at: 1 });

module.exports = mongoose.model('Comment', CommentSchema, 'Comments');
