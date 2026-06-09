const mongoose = require('mongoose');

const TeamMemberSchema = new mongoose.Schema({
  // The workspace owner who sent the invite
  owner_id:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  email:      { type: String, required: true },
  name:       { type: String, default: '' },
  role:       { type: String, enum: ['admin', 'member', 'viewer'], default: 'member' },
  status:     { type: String, enum: ['pending', 'active'], default: 'pending' },

  // Set when the invited user actually signs up / accepts
  user_id:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  invite_token: { type: String, default: null },  // used in the invite link
}, { timestamps: true });

// An email can only appear once per workspace
TeamMemberSchema.index({ owner_id: 1, email: 1 }, { unique: true });

module.exports = mongoose.model('TeamMember', TeamMemberSchema, 'TeamMembers');
