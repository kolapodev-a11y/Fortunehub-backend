const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  price: {
    type: Number,
    required: true,
    min: 0
  },
  category: {
    type: String,
    required: true,
    enum: ['phones', 'laptops', 'accessories', 'watches', 'speakers', 'games', 'other']
  },
  description: {
    type: String,
    required: true
  },
  image: {
    type: String,
    required: true
  },
  images: {
    type: [String],
    default: []
  },
  tag: {
    type: String,
    enum: ['new', 'sale', 'none'],
    default: 'none'
  },
  outOfStock: {
    type: Boolean,
    default: false
  },
  sold: {
    type: Boolean,
    default: false
  },
  statusIndicator: {
    type: String,
    enum: ['new', 'sale', 'available', 'outofstock'],
    default: 'available'
  }
}, {
  timestamps: true
});

// Virtual for status indicator based on other fields
productSchema.pre('save', function(next) {
  if (this.outOfStock) {
    this.statusIndicator = 'outofstock';
  } else if (this.tag === 'new') {
    this.statusIndicator = 'new';
  } else if (this.tag === 'sale') {
    this.statusIndicator = 'sale';
  } else {
    this.statusIndicator = 'available';
  }
  next();
});

module.exports = mongoose.model('Product', productSchema);
    
