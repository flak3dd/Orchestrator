'use strict';
// Data Models & Validations
// Generated at 2026-06-09T16:31:17.076Z
class User {
  constructor(data = {}) {
    this.username = data.username;
    this.passwordHash = data.passwordHash;
  }
  validate() {
    if (!this.username || this.username.length < 3) throw new Error('Invalid username');
    if (!this.passwordHash) throw new Error('Password is required');
    return true;
  }
}
module.exports = { User };