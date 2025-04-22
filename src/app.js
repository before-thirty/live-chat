import { Server} from "socket.io";
import {PrismaClient} from '@prisma/client'; 
import  {errors} from 'celebrate';
import express from 'express';
import http from 'http';
import { v4 as uuidv4 } from 'uuid';
import cors  from 'cors';
import dotenv from 'dotenv';


const PORT = process.env.PORT || 5002;
const prisma = new PrismaClient(); 

const app = express();
dotenv.config();
app.use(cors());
app.use(express.json());


const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
    },
});

io.on('connection', (socket)  => {
    console.log(`User connected: ${socket.id}`);


    socket.on('joinMultipleTripRooms', async (data) => {
        const requestedTripIds = data?.tripIds;
    
        if (!Array.isArray(requestedTripIds) || requestedTripIds.length === 0) {
            console.log(`SERVER: Received invalid or empty tripIds array from Socket ${socket.id}`);
            return;
        }
    
        console.log(`SERVER: Socket ${socket.id}) requested to join rooms: ${requestedTripIds.join(', ')}`);
    
        let joinedCount = 0;
        // Validate and join each requested room
        for (const tripId of requestedTripIds) {
          try {

            // Verify the authenticated user (socket.user.id) is allowed in this tripId room
            // const isAuthorized = await isUserAuthorizedForTrip(userId, tripId); // Your DB check function
    
            await socket.join(tripId); // Use await if your adapter needs it (e.g., Redis)
            console.log(`SERVER: Socket ${socket.id} successfully joined room: ${tripId}`);
            // Optional: Confirm success back to client for this specific room
            socket.emit('joinRoomSuccess', { tripId });
            joinedCount++;
            
          } catch (error) {
              console.error(`SERVER: Error joining room ${tripId}  (Socket ${socket.id}):`, error);
              socket.emit('joinRoomError', { tripId, error: 'Server error during join' });
          }
        }
         console.log(`SERVER: Socket ${socket.id}) joined ${joinedCount} out of ${requestedTripIds.length} requested rooms.`);
         // Optional: Log final rooms for the socket
         console.log(`SERVER: Socket ${socket.id} final rooms:`, Array.from(socket.rooms));
      });

    // user joins the trip 
    socket.on('joinGroup', async ({ tripId, userId }) => {
        try {
            // Join the Socket.IO room
            console.log(`${socket.id} joining ${tripId} `);
            if (!tripId || !userId) {
                console.log('Trip ID and User ID are required');
                socket.emit('error', { message: 'Group ID and User ID are required' });
                return;
            }

            await prisma.tripUser.create({
                data: {
                    tripId,
                    userId
                }
            });
            
            socket.join(tripId);

            // fetch the group members
            const members = await prisma.trip.findUnique({
                where: {
                    id: tripId,
                },
                include: {
                    tripUsers: true,
                }
            });

            if (!members) {
                console.log(`Trip ${tripId} not found`);
                socket.emit('error', { message: `Trip ${tripId} not found` });
                return;
            }

            // Emit the initial group data, including members and messages, to the user.
            socket.emit('groupJoined', { members });

            // Notify other users in the group that a new user has joined (optional).  Adjust as needed.
            socket.to(tripId).emit('userJoinedGroup', { userId, tripId }); //send to others in the room
            console.log(`User ${userId} joined group ${tripId}`);

        } catch (error) {
            console.error('Error joining group:', error);
            socket.emit('error', { message: 'Failed to join group' });
        }
    });

    socket.on('sendMessage', async ({user, tripId, messageToSend}) => {
        try {
            console.log(messageToSend)
            io.to(tripId).emit('messageReceived', { tripId, message: messageToSend });

            console.log(`Message sent to group ${tripId} by user ${user}`);
        } catch (error) {
            console.error('Error sending message:', error);
            socket.emit('error', { message: 'Failed to send message' });
        }
    });

    socket.on('disconnect', () => {
        console.log(`Socket disconnected: ${socket.id}`);
    });
});

// ===============================
// API Endpoints
// ===============================

// Get all groups
app.get('/groups', async (req, res) => {
    try {
        const groups = await prisma.group.findMany({
            include: {
                members: true,
                messages: true,
            },
        });
        res.json(groups);
    } catch (error) {
        console.error('Error getting groups:', error);
        res.status(500).json({ message: 'Failed to get groups' });
    }
});

// Get a specific group
app.get('/groups/:groupId', async (req, res) => {
    const { groupId } = req.params;
    try {
        const group = await prisma.group.findUnique({
            where: {
                id: groupId,
            },
            include: {
                members: true,
                messages: true
            },
        });
        if (!group) {
            return res.status(404).json({ message: 'Group not found' });
        }
        res.json(group);
    } catch (error) {
        console.error('Error getting group:', error);
        res.status(500).json({ message: 'Failed to get group' });
    }
});

// Create a new group
app.post('/groups', async (req, res) => {
    const { name, memberIds } = req.body;

    if (!name || !memberIds || !Array.isArray(memberIds)) {
        return res.status(400).json({ message: 'Name and memberIds are required' });
    }

    try {
        // Fetch user details for the provided IDs
        const members = await prisma.user.findMany({
            where: {
                id: {
                    in: memberIds,
                },
            },
        });

         if (members.length !== memberIds.length) {
            return res.status(400).json({ message: 'Some members does not exist' });
        }

        const newGroup = await prisma.group.create({
            data: {
                id: uuidv4(),
                name,
                members: {
                    connect: members.map((member) => ({ id: member.id })),
                },
                messages: {
                  create: []
                }
            },
            include: {
                members: true, // Include the member data in the response
                messages: true
            }
        });
        res.status(201).json(newGroup);
    } catch (error) {
        console.error('Error creating group:', error);
        res.status(500).json({ message: 'Failed to create group' });
    }
});

// Add a user to a group
app.post('/groups/:groupId/join', async (req, res) => {
    const { groupId } = req.params;
    const { userId } = req.body;

    if (!userId) {
        return res.status(400).json({ message: 'User ID is required' });
    }

    try {
        const user = await prisma.user.findUnique({
            where: {
                id: userId,
            },
        });
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const group = await prisma.group.update({
            where: {
                id: groupId,
            },
            data: {
                members: {
                    connect: [{ id: userId }],
                },
            },
            include: {
                members: true,
                messages: true
            }
        });

        if (!group) {
            return res.status(404).json({ message: 'Group not found' });
        }
        res.json(group);
    } catch (error) {
        console.error('Error joining group:', error);
        res.status(500).json({ message: 'Failed to join group' });
    }
});

// Remove a user from a group
app.post('/groups/:groupId/leave', async (req, res) => {
    const { groupId } = req.params;
    const { userId } = req.body;

    if (!userId) {
        return res.status(400).json({ message: 'User ID is required' });
    }

    try {
        const group = await prisma.group.update({
            where: {
                id: groupId,
            },
            data: {
                members: {
                    disconnect: [{ id: userId }],
                },
            },
            include: {
                members: true,
                messages: true
            }
        });
        if (!group) {
            return res.status(404).json({ message: 'Group not found' });
        }
        res.json(group);
    } catch (error) {
        console.error('Error leaving group:', error);
        res.status(500).json({ message: 'Failed to leave group' });
    }
});


server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
