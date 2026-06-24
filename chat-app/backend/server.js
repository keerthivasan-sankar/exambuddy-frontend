require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');

const app = express();

// ==================== MIDDLEWARE ====================
app.use((req, res, next) => {
  const allowedOrigins = [
    'https://exambuddy-frontend.vercel.app',
    'https://exambuddy-frontier.vercel.app',
    'http://localhost:3000',
    'http://localhost:5000'
  ];
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, X-Requested-With');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).send('OK');
  }
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ==================== MONGODB CONNECTION ====================
console.log('🔗 Connecting to MongoDB...');
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => {
  console.log('✅ MongoDB Connected successfully!');
})
.catch(err => {
  console.error('❌ MongoDB Connection Error:', err.message);
});

// ==================== MODELS ====================

// User Schema
const userSchema = new mongoose.Schema({
  mobile: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  gender: { type: String, enum: ['Male', 'Female', 'Other'], default: 'Other' },
  homeCity: { type: String, required: true },
  verified: { type: Boolean, default: true },
  avatar: { type: String },
  avatarPublicId: { type: String },
  createdAt: { type: Date, default: Date.now }
});

userSchema.pre('save', function(next) {
  if (!this.avatar) {
    this.avatar = this.name.charAt(0).toUpperCase();
  }
  next();
});

const User = mongoose.model('User', userSchema);

// Exam Schema
const examSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  examName: { type: String, required: true },
  examDate: { type: String, required: true },
  examCity: { type: String, required: true },
  examCenter: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});

const Exam = mongoose.model('Exam', examSchema);

// Message Schema - UPDATED with chat separation
const messageSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  userName: { type: String, required: true },
  message: { type: String, required: true },
  messageType: { type: String, enum: ['text', 'image', 'file', 'location'], default: 'text' },
  fileUrl: { type: String },
  filePublicId: { type: String },
  latitude: { type: Number },
  longitude: { type: Number },
  chatType: { type: String, enum: ['global', 'group', 'private'], default: 'global' },
  groupId: { type: String, default: 'global' },
  privateChatId: { type: String },
  timestamp: { type: Date, default: Date.now }
});

messageSchema.index({ chatType: 1, groupId: 1 });
messageSchema.index({ chatType: 1, privateChatId: 1 });
messageSchema.index({ timestamp: -1 });

const Message = mongoose.model('Message', messageSchema);

// Travel Plan Schema
const travelPlanSchema = new mongoose.Schema({
  examId: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  travelMode: { type: String, enum: ['Train', 'Bus', 'Cab', 'Flight', 'Other'], default: 'Train' },
  departureTime: { type: String },
  departureLocation: { type: String },
  contactInfo: { type: String },
  notes: { type: String },
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  createdAt: { type: Date, default: Date.now }
});

const TravelPlan = mongoose.model('TravelPlan', travelPlanSchema);

// ==================== AUTH MIDDLEWARE ====================
const authMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// ==================== API ROUTES ====================

app.get('/', (req, res) => {
  res.send('ExamBuddy API is running!');
});

// ---------- AUTH ROUTES ----------
app.post('/api/auth/register', async (req, res) => {
  try {
    const { mobile, name, gender, homeCity } = req.body;

    if (!mobile || !name || !homeCity) {
      return res.status(400).json({ error: 'Please fill all required fields' });
    }
    if (!/^\d{10}$/.test(mobile)) {
      return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number' });
    }

    let user = await User.findOne({ mobile });

    if (user) {
      const token = jwt.sign(
        { id: user._id, mobile: user.mobile },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRE || '7d' }
      );
      return res.json({ user, token, isNew: false });
    }

    user = new User({ mobile, name, gender, homeCity });
    await user.save();

    const token = jwt.sign(
      { id: user._id, mobile: user.mobile },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRE || '7d' }
    );

    res.status(201).json({ user, token, isNew: true });
  } catch (error) {
    console.error('❌ Register Error:', error);
    res.status(500).json({ error: error.message || 'Server error' });
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  res.json({ user: req.user });
});

// ---------- MESSAGE ROUTES ----------
app.get('/api/messages', authMiddleware, async (req, res) => {
  try {
    const { type, userId, groupId } = req.query;
    let filter = {};
    
    if (type === 'private' && userId) {
      const privateChatId = [req.user._id.toString(), userId].sort().join('_');
      filter = { chatType: 'private', privateChatId: privateChatId };
    } else if (type === 'group') {
      filter = { chatType: 'group', groupId: groupId || 'global' };
    } else {
      filter = { chatType: 'global' };
    }

    const messages = await Message.find(filter)
      .sort({ timestamp: 1 })
      .limit(100)
      .populate('userId', 'name avatar');
    
    res.json(messages);
  } catch (error) {
    console.error('❌ Get messages error:', error);
    res.status(500).json({ error: 'Failed to get messages' });
  }
});

app.post('/api/messages', authMiddleware, async (req, res) => {
  try {
    const { user, content, type, chatType, targetUserId, groupId } = req.body;

    // ===== FIX: Proper validation =====
    if (!user) {
      return res.status(400).json({ error: 'User is required' });
    }
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Content is required' });
    }

    const messageData = {
      userId: req.user._id,
      userName: user,
      message: content.trim(),
      messageType: type || 'text',
      timestamp: new Date()
    };

    if (chatType === 'private' && targetUserId) {
      const privateChatId = [req.user._id.toString(), targetUserId].sort().join('_');
      messageData.chatType = 'private';
      messageData.privateChatId = privateChatId;
      messageData.groupId = privateChatId;
    } else if (chatType === 'group') {
      messageData.chatType = 'group';
      messageData.groupId = groupId || 'global';
    } else {
      messageData.chatType = 'global';
      messageData.groupId = 'global';
    }

    const newMessage = new Message(messageData);
    await newMessage.save();
    await newMessage.populate('userId', 'name avatar');
    
    res.status(201).json(newMessage);
  } catch (error) {
    console.error('❌ Send message error:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ---------- GROUP CHAT ROUTES ----------
app.get('/api/chats/group', authMiddleware, async (req, res) => {
  try {
    const messages = await Message.find({ chatType: 'group' })
      .sort({ timestamp: 1 })
      .populate('userId', 'name avatar')
      .limit(100);
    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/chats/group', authMiddleware, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message cannot be empty' });
    }

    const newMessage = new Message({
      userId: req.user._id,
      userName: req.user.name,
      message: message.trim(),
      chatType: 'group',
      groupId: 'global'
    });

    await newMessage.save();
    await newMessage.populate('userId', 'name avatar');
    res.status(201).json(newMessage);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ---------- PRIVATE CHAT ROUTES ----------
app.get('/api/chats/private/:otherUserId', authMiddleware, async (req, res) => {
  try {
    const { otherUserId } = req.params;
    const privateChatId = [req.user._id.toString(), otherUserId].sort().join('_');

    const messages = await Message.find({ 
      chatType: 'private',
      privateChatId: privateChatId 
    })
    .sort({ timestamp: 1 })
    .populate('userId', 'name avatar')
    .limit(100);

    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/chats/private/:otherUserId', authMiddleware, async (req, res) => {
  try {
    const { otherUserId } = req.params;
    const { message } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message cannot be empty' });
    }

    const privateChatId = [req.user._id.toString(), otherUserId].sort().join('_');

    const newMessage = new Message({
      userId: req.user._id,
      userName: req.user.name,
      message: message.trim(),
      chatType: 'private',
      privateChatId: privateChatId,
      groupId: privateChatId
    });

    await newMessage.save();
    await newMessage.populate('userId', 'name avatar');
    res.status(201).json(newMessage);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ---------- EXAM ROUTES ----------
app.get('/api/exams', authMiddleware, async (req, res) => {
  try {
    const exams = await Exam.find().sort({ createdAt: -1 });
    res.json(exams);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/exams', authMiddleware, async (req, res) => {
  try {
    const { examName, examDate, examCity, examCenter } = req.body;

    if (!examName || !examDate || !examCity) {
      return res.status(400).json({ error: 'Please fill all required fields' });
    }

    const exam = new Exam({
      userId: req.user._id,
      examName,
      examDate,
      examCity,
      examCenter: examCenter || ''
    });

    await exam.save();
    res.status(201).json(exam);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Server error' });
  }
});

app.delete('/api/exams/:id', authMiddleware, async (req, res) => {
  try {
    const exam = await Exam.findOne({ _id: req.params.id, userId: req.user._id });
    if (!exam) {
      return res.status(404).json({ error: 'Exam not found' });
    }
    await exam.deleteOne();
    res.json({ message: 'Exam deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Server error' });
  }
});

// ---------- MATCHING ROUTES ----------
app.get('/api/matches', authMiddleware, async (req, res) => {
  try {
    const userExams = await Exam.find({ userId: req.user._id });

    if (userExams.length === 0) {
      return res.json([]);
    }

    const matches = [];

    for (const exam of userExams) {
      const matchingExams = await Exam.find({
        _id: { $ne: exam._id },
        examName: exam.examName,
        examDate: exam.examDate,
        examCity: exam.examCity
      }).populate('userId', 'name mobile avatar homeCity gender');

      for (const matchingExam of matchingExams) {
        const buddy = matchingExam.userId;
        if (buddy && buddy._id.toString() !== req.user._id.toString()) {
          matches.push({
            exam: {
              id: exam._id,
              examName: exam.examName,
              examDate: exam.examDate,
              examCity: exam.examCity,
              examCenter: exam.examCenter
            },
            buddy: {
              id: buddy._id,
              name: buddy.name,
              mobile: buddy.mobile,
              avatar: buddy.avatar,
              homeCity: buddy.homeCity,
              gender: buddy.gender
            },
            buddyExam: {
              examCenter: matchingExam.examCenter
            }
          });
        }
      }
    }

    const uniqueMatches = [];
    const seen = new Set();
    for (const match of matches) {
      const key = `${match.buddy.id}-${match.exam.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueMatches.push(match);
      }
    }

    res.json(uniqueMatches);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Server error' });
  }
});

// ---------- STATS ROUTE ----------
app.get('/api/stats', async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const totalExams = await Exam.countDocuments();
    const totalMessages = await Message.countDocuments();

    res.json({
      totalUsers,
      totalExams,
      totalMessages,
      mongodb: 'connected'
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Server error' });
  }
});

app.get('/api/test', (req, res) => {
  res.json({ message: 'API is working!' });
});

// ==================== START SERVER ====================
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n============================');
  console.log('    EXAM BUDDY BACKEND READY!');
  console.log('============================');
  console.log(`    PORT: ${PORT}`);
  console.log(`    MongoDB: Connected ✅`);
  console.log('');
});