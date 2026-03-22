import React from 'react'
import { ScrollView } from 'react-native'
import BookmarkTabs from './BookmarkTabs'
import tabStore from '../../stores/TabStore'

const Tabs: React.FC = () => {
  return (
    <ScrollView>
      {tabStore.tabs.map((tab, index) => (
        <BookmarkTabs
          key={tab.id}
          tab={tab}
          index={index}
          removeTab={(i: number) => tabStore.closeTab(tabStore.tabs[i].id)}
        />
      ))}
    </ScrollView>
  )
}

export default Tabs
