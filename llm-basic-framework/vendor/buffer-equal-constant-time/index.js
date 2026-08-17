'use strict';

var Buffer = require('buffer').Buffer;
var timingSafeEqual = require('crypto').timingSafeEqual;
var originalEqual = Buffer.prototype.equal;

function bufferEqual(a, b) {
  return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.length === b.length && timingSafeEqual(a, b);
}

bufferEqual.install = function install() {
  Buffer.prototype.equal = function equal(that) {
    return bufferEqual(this, that);
  };
};

bufferEqual.restore = function restore() {
  Buffer.prototype.equal = originalEqual;
};

module.exports = bufferEqual;
