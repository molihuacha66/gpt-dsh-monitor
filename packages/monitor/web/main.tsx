import React from 'react';
import {createRoot} from 'react-dom/client';
import {ConversationApp} from './conversation.tsx';
import {browserReader} from './reader.ts';
createRoot(document.getElementById('root')!).render(<ConversationApp read={browserReader}/>);
