
const whatsapp = require('./whatsapp');
const fs = require('fs');

exports.createGroups = async (req, res) => {
  try {
    const { name, count } = req.body;
    const userId = req.headers['user-id'] || req.body.userId;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    if (!name || !count || count < 1 || count > 30) {
      return res.status(400).json({ error: 'Invalid group name or count' });
    }

    // Extract base name and start number from the input 'name'
    const nameParts = name.split(" ");
    let startNumber = parseInt(nameParts[nameParts.length - 1]);
    let baseName = nameParts.slice(0, nameParts.length - 1).join(" ");
    
    // If last part is not a valid number, treat entire name as base and start from 1
    if (isNaN(startNumber)) {
      startNumber = 1;
      baseName = name;
    }
    
    console.log(`Starting group creation: Base name "${baseName}", Starting from ${startNumber}, Count: ${count}`);

    const sock = whatsapp.getSock(userId);
    if (!sock) {
      return res.status(500).json({ error: 'WhatsApp not connected for this user' });
    }

    const links = [];
    const failedGroups = [];

    // Send immediate response with progress tracking
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Cache-Control'
    });

    // Send start notification
    res.write(`data: ${JSON.stringify({
      type: 'start',
      totalGroups: count,
      startNumber: startNumber,
      baseName: baseName,
      message: `Starting to create ${count} groups from "${baseName} ${startNumber}"`
    })}\n\n`);

    for (let i = 0; i < count; i++) {
      const groupNumber = startNumber + i;
      const groupName = `${baseName} ${groupNumber}`;

      try {
        // Check if connection is still active
        const currentSock = whatsapp.getSock(userId);
        if (!currentSock || !currentSock.user) {
          console.log(`❌ Connection lost for user ${userId}, skipping remaining groups...`);
          res.write(`data: ${JSON.stringify({
            type: 'error',
            message: 'WhatsApp connection lost. Please reconnect and try again.',
            current: i + 1,
            total: count
          })}\n\n`);
          break;
        }

        console.log(`Creating group ${i + 1}/${count}: ${groupName}`);

        // Create empty group (no participants)
        const group = await currentSock.groupCreate(groupName, []);
        console.log(`✅ Group "${groupName}" created with ID: ${group.id}`);

        // Wait 3 seconds before configuring settings
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Configure group settings automatically
        let addMembersWarning = false;
        try {
          const settingSock = whatsapp.getSock(userId);
          if (settingSock && settingSock.user) {
            // 1. Allow all members to edit group info
            await settingSock.groupSettingUpdate(group.id, 'unlocked');
            console.log(`✅ Setting 1: Enabled group info editing for all members in ${groupName}`);
            
            // Small delay between settings
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // 2. Allow all members to send messages
            await settingSock.groupSettingUpdate(group.id, 'not_announcement');
            console.log(`✅ Setting 2: Enabled messaging for all members in ${groupName}`);
            
            // Small delay between settings
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // 3. Allow all members to add other members
            try {
              await settingSock.groupSettingUpdate(group.id, 'unlocked');
              console.log(`✅ Setting 3: Enabled member addition for all members in ${groupName}`);
            } catch (addMemberError) {
              console.log(`⚠️ Could not enable member addition for ${groupName}:`, addMemberError.message);
              addMembersWarning = true;
            }
          }
        } catch (settingsError) {
          console.log(`⚠️ Warning: Could not configure all settings for ${groupName}:`, settingsError.message);
          addMembersWarning = true;
        }

        // Wait 2 seconds before getting invite code
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Get invite code
        let inviteCode;
        try {
          const activeSock = whatsapp.getSock(userId);
          if (activeSock && activeSock.user) {
            inviteCode = await activeSock.groupInviteCode(group.id);
          }
        } catch (inviteError) {
          console.log(`❌ Failed to get invite code for ${groupName}:`, inviteError.message);
        }

        if (inviteCode) {
          const inviteLink = `https://chat.whatsapp.com/${inviteCode}`;
          links.push({
            groupName,
            link: inviteLink,
            groupId: group.id
          });
          console.log(`✅ Invite link generated for ${groupName}`);

          // Send link immediately
          res.write(`data: ${JSON.stringify({
            type: 'link',
            groupName: groupName,
            link: inviteLink,
            groupId: group.id,
            current: i + 1,
            total: count,
            addMembersWarning: addMembersWarning
          })}\n\n`);
        } else {
          failedGroups.push(groupName);
          console.log(`❌ Failed to get invite code for ${groupName}`);

          // Send failure notification
          res.write(`data: ${JSON.stringify({
            type: 'failed',
            groupName: groupName,
            current: i + 1,
            total: count,
            reason: 'Failed to get invite code'
          })}\n\n`);
        }

      } catch (error) {
        failedGroups.push(groupName);
        console.error(`❌ Error creating group ${groupName}:`, error.message);

        // Send failure notification
        res.write(`data: ${JSON.stringify({
          type: 'failed',
          groupName: groupName,
          current: i + 1,
          total: count,
          reason: error.message
        })}\n\n`);
      }

      // Wait exactly 10 seconds before next group (except for the last group)
      if (i < count - 1) {
        console.log(`⏳ Waiting 10 seconds before next group...`);

        // Send wait notification
        res.write(`data: ${JSON.stringify({
          type: 'wait',
          current: i + 1,
          total: count,
          delaySeconds: 10,
          message: `Waiting 10 seconds before creating next group...`
        })}\n\n`);

        await new Promise(resolve => setTimeout(resolve, 10000));
      }
    }

    // Create text file with all links
    if (links.length > 0) {
      try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `${baseName.replace(/\s+/g, '_')}_${timestamp}.txt`;
        const filepath = `./generated_links/${filename}`;
        
        // Ensure directory exists
        if (!fs.existsSync('./generated_links')) {
          fs.mkdirSync('./generated_links');
        }

        let fileContent = `WhatsApp Group Links - ${baseName}\n`;
        fileContent += `Created: ${new Date().toLocaleString()}\n`;
        fileContent += `Total Groups: ${links.length}\n\n`;
        
        links.forEach((link, index) => {
          fileContent += `${index + 1}. ${link.groupName}\n`;
          fileContent += `   ${link.link}\n\n`;
        });

        fs.writeFileSync(filepath, fileContent);
        console.log(`✅ Links saved to file: ${filename}`);
      } catch (fileError) {
        console.error('❌ Error saving links to file:', fileError.message);
      }
    }

    // Send final summary
    const summary = {
      type: 'complete',
      success: true,
      totalRequested: count,
      successfulGroups: links.length,
      failedGroups: failedGroups.length,
      failed: failedGroups,
      message: `✅ Group creation completed: ${links.length}/${count} successful`,
      startNumber: startNumber,
      baseName: baseName
    };

    res.write(`data: ${JSON.stringify(summary)}\n\n`);
    res.end();
    console.log(`🎉 Group creation completed: ${links.length}/${count} successful`);

  } catch (error) {
    console.error('❌ Critical error in createGroups:', error);
    if (!res.headersSent) {
      res.status(500).json({ 
        error: 'Failed to create groups', 
        details: error.message 
      });
    }
  }
};
